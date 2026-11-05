/**
 * PipelineService — orchestrates the async multi-agent analysis pipeline for a
 * single stock run.
 *
 * Stage ordering (see runPipeline):
 *   0. setStatus('fetching') — mark run as in-progress, record startedAt.
 *   1. Evidence collection: pull live quote + portfolio/watchlist rows via
 *      EvidenceService.collectEvidence. Persist rows to agent_evidence.
 *   2. Bull/Bear debate: two parallel LLM calls (bull + bear) generate opening
 *      arguments; then two more parallel calls generate rebuttals. Each side's
 *      output is parsed as JSON and persisted to bull_bear_arguments and
 *      debate_records. Round-2 failures are non-fatal (logged as warning).
 *   3. Critique: a single LLM call (chatSlow, free text) that criticizes both
 *      sides' weakest points. Stored as a round-3 debate record by the `critic`.
 *   4. Risk gate: evaluate the user's hard/soft strategy rules against the
 *      current portfolio (no LLM). `hard` rule failures cap the final rating.
 *   5. Rating aggregation: one final LLM call that consumes evidence summary +
 *      bull/bear/critic + risk summary and emits a JSON rating object. The
 *      result is post-processed with two hard overrides (see runRatingPhase)
 *      before being saved.
 *
 * After stage 5 the run transitions to `awaiting_human` and the HTTP client
 * polls until a human approves/modifies/rejects.
 *
 * Cancellation: between every stage the pipeline calls `isCancelled` which
 * re-reads the run row; if the user hit cancel, the pipeline bails out without
 * advancing state.
 *
 * Completion notification: on both success and failure, `notifyComplete`
 * invokes callbacks (registered by BatchService) so the queue can release a
 * concurrency slot and dequeue the next item.
 *
 * Token accounting: tokensUsed is accumulated across LLM calls and persisted
 * on the run row for cost tracking.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and } from 'drizzle-orm';
import { agentRuns } from '@server/database/schema';
import { LlmService } from './llm.service';
import { EvidenceService } from './evidence.service';
import { PortfolioContextService } from './portfolio-context.service';
import type {
  AgentEvidence,
  BullBearArgument,
  AgentRunStatus,
  StrategyRule,
  AgentRating,
  AgentConfidence,
  AgentRunMode,
  AnalysisLanguage,
} from '@shared/api.interface';
import { MultiAgentService } from './multi-agent.service';
import { languageInstruction, englishRuleName, safeAnalysisError, analysisErrorCode } from './analysis-report';
import type { ModelRoute } from '../../../shared/model-route.interface';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  /** Callbacks fired when any run finishes (success, failure, or cancel).
   *  BatchService registers one to free a concurrency slot. */
  private completeCallbacks: Array<(runId: string, userId: string, mode: AgentRunMode) => void> = [];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly llmService: LlmService,
    private readonly evidenceService: EvidenceService,
    private readonly portfolioContextService: PortfolioContextService,
    private readonly multiAgentService: MultiAgentService,
  ) {}

  /**
   * Register a callback invoked when a run completes (for any terminal state).
   * Used by BatchService to release a concurrency slot and process the queue.
   * @param cb callback receiving runId, userId, and the run's mode.
   */
  onRunComplete(cb: (runId: string, userId: string, mode: AgentRunMode) => void): void {
    this.completeCallbacks.push(cb);
  }

  /**
   * Fire all registered completion callbacks. Each callback is wrapped in
   * try/catch so one bad listener cannot break the others or the pipeline.
   */
  private notifyComplete(runId: string, userId: string, mode: AgentRunMode): void {
    for (const cb of this.completeCallbacks) {
      try {
        cb(runId, userId, mode);
      } catch (err) {
        this.logger.error(`Complete callback error: ${analysisErrorCode(err)}`);
      }
    }
  }

  /**
   * Fire-and-forget entry point that starts the pipeline. The returned promise
   * is intentionally not awaited by the caller (controller returns immediately);
   * all errors are logged here.
   * @param runId the agent_runs.id to run.
   * @param userId owner, used for owner-scoped DB writes and cancellation check.
   */
  startPipeline(runId: string, userId: string, queuedMode?: AgentRunMode): void {
    void this.runPipeline(runId, userId, queuedMode).catch((err) => {
      this.logger.error(`Pipeline failed for run ${runId}: ${analysisErrorCode(err)}`);
    });
  }

  /**
   * Internal driver for the full pipeline. Runs all five stages in order,
   * checking cancellation between each. On error, transitions the run to
   * `failed` and writes an audit log, then still fires notifyComplete so the
   * batch queue can make progress.
   */
  private async runPipeline(runId: string, userId: string, queuedMode?: AgentRunMode): Promise<void> {
    let tokensUsed = 0;
    let mode: AgentRunMode | null = null;
    let language: AnalysisLanguage = 'zh-CN';
    // A manually restarted failed run must not reuse an earlier native task's result.
    const attemptId = randomUUID();
    const addTokens = (n: number): void => {
      tokensUsed += n;
    };

    try {
      const runDetail = await this.multiAgentService.getRun(userId, runId);
      mode = runDetail.runMode;
      language = runDetail.language ?? 'zh-CN';
      if (await this.isCancelled(runId, userId)) return;
      if (runDetail.status === 'failed') await this.multiAgentService.resetFailedRunArtifacts(userId, runId);
      await this.setStatus(runId, userId, 'fetching', { startedAt: new Date(), errorMessage: null });
      const ticker = runDetail.ticker;
      const route = runDetail.modelRoute ?? undefined;
      const useLlm = route ? route.mode !== 'basic' : await this.llmService.isConfigured(userId);
      const execution = useLlm ? await this.llmService.getExecutionInfo(userId, route) : null;

      if (await this.isCancelled(runId, userId)) return;

      // Phase 1: Evidence collection
      this.logger.log(`Phase 1: Fetching evidence for ${ticker}`);
      const portfolio = await this.portfolioContextService.getPortfolioContext(userId);
      const evidence = await this.evidenceService.collectEvidence(ticker, userId, portfolio, language);

      // Persist facts and explicit gaps. Debate citations use only returned IDs.
      const savedEvidence = await this.multiAgentService.addProviderEvidence(
        userId,
        runId,
        evidence.map((e) => ({
          role: e.role,
          evidenceType: e.evidenceType,
          title: e.title,
          content: e.content,
          sourceUrl: e.sourceUrl,
          sourceName: e.sourceName,
          fetchedAt: new Date().toISOString(),
          relevanceScore: e.relevanceScore,
          metadata: e.metadata,
        })),
      );

      if (await this.isCancelled(runId, userId)) return;

      // Phase 2: Bull/Bear debate
      this.logger.log(`Phase 2: Bull/Bear debate for ${ticker}`);
      if (useLlm) await this.setStatus(runId, userId, 'debating');
      const debateTokens = useLlm ? await this.runDebatePhase(runId, userId, ticker, savedEvidence, language, route, attemptId) : 0;
      addTokens(debateTokens);

      if (await this.isCancelled(runId, userId)) return;

      // Phase 3: Critique
      this.logger.log(`Phase 3: Critique for ${ticker}`);
      if (useLlm) await this.setStatus(runId, userId, 'critiquing');
      const critiqueTokens = useLlm ? await this.runCritiquePhase(runId, userId, language, route, attemptId) : 0;
      addTokens(critiqueTokens);

      if (await this.isCancelled(runId, userId)) return;

      // Phase 4: Risk gate
      this.logger.log(`Phase 4: Risk gate for ${ticker}`);
      await this.setStatus(runId, userId, 'risk_check');
      const rules = await this.multiAgentService.getStrategyRules(userId);
      const riskResults = this.portfolioContextService.checkRiskRules(ticker, portfolio, rules);
      await this.multiAgentService.saveRiskGateResults(
        userId,
        runId,
        riskResults.map((r) => ({
          ruleName: language === 'en' ? englishRuleName(r.ruleName) : r.ruleName,
          ruleType: r.ruleType,
          passed: r.passed,
          currentValue: r.currentValue,
          thresholdValue: r.thresholdValue,
          detail: language === 'en'
            ? r.currentValue === null
              ? 'This rule could not be verified from the available data or configured threshold.'
              : `Measured value: ${r.currentValue}. Configured threshold: ${r.thresholdValue ?? 'unavailable'}. Result: ${r.passed ? 'passed' : 'failed'}.`
            : r.detail,
          suggestedAction: language === 'en'
            ? r.passed ? 'No violation was detected by this check.' : 'Review the configured rule and missing evidence before trading.'
            : r.suggestedAction,
        })),
      );

      // A hard-rule failure does NOT abort the pipeline, but it caps the
      // final rating (no Buy/Strong Buy allowed).
      const hasHardFailure = riskResults.some((r) => r.ruleType === 'hard' && !r.passed);

      if (await this.isCancelled(runId, userId)) return;

      // Phase 5: Rating aggregation
      this.logger.log(`Phase 5: Rating aggregation for ${ticker}`);
      const ratingTokens = useLlm
        ? await this.runRatingPhase(runId, userId, ticker, hasHardFailure, rules, language, route, attemptId)
        : await this.runBasicRatingPhase(runId, userId, ticker, language);
      addTokens(ratingTokens);
      if (await this.isCancelled(runId, userId)) return;
      await this.multiAgentService.savePipelineReport(userId, runId, useLlm ? 'llm' : 'basic', execution);

      // Final: awaiting human decision
      await this.setStatus(runId, userId, 'awaiting_human', {
        completedAt: new Date(),
        tokensUsed,
      });

      await this.multiAgentService.addAuditLog(userId, runId, 'run_completed', {
        ticker,
        tokensUsed,
        hasHardFailure,
        language,
        engine: useLlm ? 'llm' : 'basic',
      });

      this.logger.log(`Pipeline completed for run ${runId} (${ticker}), tokens: ${tokensUsed}`);
    } catch (error) {
      const errorMsg = safeAnalysisError(error, language);
      this.logger.error(`Pipeline error for run ${runId}: ${analysisErrorCode(error)}`);
      try {
        await this.setStatus(runId, userId, 'failed', {
          errorMessage: errorMsg,
          completedAt: new Date(),
          tokensUsed,
        });
        await this.multiAgentService.addAuditLog(userId, runId, 'run_failed', {
          error: errorMsg,
          tokensUsed,
        });
      } catch (updateErr) {
        this.logger.error(`Failed to update run status to failed: ${analysisErrorCode(updateErr)}`);
      }
    } finally {
      // The queue already reserved a mode-specific slot. Release it even when
      // the first database read fails before the run's mode can be loaded.
      const completedMode = queuedMode ?? mode;
      if (completedMode) this.notifyComplete(runId, userId, completedMode);
    }
  }

  /**
   * Owner-scoped cancellation check. Re-reads the run row; returns true iff the
   * row exists and its status is 'cancelled'.
   */
  private async isCancelled(runId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)));
    return row?.status === 'cancelled';
  }

  /**
   * Update the run row's status and optional metadata (startedAt, completedAt,
   * errorMessage, tokensUsed). Always owner-scoped.
   */
  private async setStatus(
    runId: string,
    userId: string,
    status: AgentRunStatus,
    extra?: { startedAt?: Date; completedAt?: Date; errorMessage?: string | null; tokensUsed?: number },
  ): Promise<void> {
    const patch: Record<string, unknown> = { status, updatedBy: userId };
    if (extra?.startedAt !== undefined) patch.startedAt = extra.startedAt;
    if (extra?.completedAt !== undefined) patch.completedAt = extra.completedAt;
    if (extra?.errorMessage !== undefined) patch.errorMessage = extra.errorMessage;
    if (extra?.tokensUsed !== undefined) patch.tokensUsed = extra.tokensUsed;

    await this.db
      .update(agentRuns)
      .set(patch)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)));
  }

  /**
   * Run the bull/bear debate: two opening arguments (parallel LLM calls) then
   * two rebuttal rounds (parallel LLM calls). Rebuttal failures are logged but
   * do NOT fail the whole run — the opening round is enough.
   * @returns total tokens consumed across all debate LLM calls.
   */
  private async runDebatePhase(
    runId: string,
    userId: string,
    ticker: string,
    evidence: AgentEvidence[],
    language: AnalysisLanguage = 'zh-CN',
    route?: ModelRoute,
    attemptId?: string,
  ): Promise<number> {
    const facts = evidence.filter((item) => !this.isDataGap(item));
    const missing = evidence.filter((item) => this.isDataGap(item));
    const evidenceText = this.formatEvidence(facts);
    const missingText = missing.map((item) => `- ${item.title}: ${item.content}`).join('\n');
    const validIds = new Set(facts.map((item) => item.id));
    let totalTokens = 0;

    // Output language is captured on the run; JSON keys and citation IDs stay stable.
    const bullPrompt = `你是一位看多的股票研究员（Bull Analyst）。请仔细阅读以下关于 ${ticker} 的已保存证据。
仅在证据足够时提出看多理由，每条理由都要引用证据 ID 和具体数据。
缺失数据不能作为事实引用，也不能自行补造数字；如果没有可引用的理由，返回空 arguments。

【可引用证据】
${evidenceText || '（无）'}

【缺失数据，不可引用】
${missingText || '（无）'}

请以 JSON 格式返回：
{
  "arguments": [
    { "point": "有证据支持的理由", "evidence_refs": ["上方证据 ID"] },
    ...
  ]
}`;

    const bearPrompt = `你是一位看空的股票研究员（Bear Analyst）。请仔细阅读以下关于 ${ticker} 的已保存证据。
仅在证据足够时提出看空理由，每条理由都要引用证据 ID 和具体数据。
缺失数据不能作为事实引用，也不能自行补造数字；如果没有可引用的理由，返回空 arguments。

【可引用证据】
${evidenceText || '（无）'}

【缺失数据，不可引用】
${missingText || '（无）'}

请以 JSON 格式返回：
{
  "arguments": [
    { "point": "有证据支持的理由", "evidence_refs": ["上方证据 ID"] },
    ...
  ]
}`;

    // Opening round: run bull and bear in parallel via the "slow" (pro) model.
    const [bullResult, bearResult] = await Promise.all([
      this.llmService.chatSlowJSON([{ role: 'system', content: languageInstruction(language) }, { role: 'user', content: bullPrompt }], userId,
        { taskId: `analysis:${runId}`, purpose: `analysis-bull-opening${attemptId && route?.mode === 'local' ? `:${attemptId}` : ''}`, maxOutputTokens: 1000, route,
          shouldContinue: async () => !(await this.isCancelled(runId, userId)) }),
      this.llmService.chatSlowJSON([{ role: 'system', content: languageInstruction(language) }, { role: 'user', content: bearPrompt }], userId,
        { taskId: `analysis:${runId}`, purpose: `analysis-bear-opening${attemptId && route?.mode === 'local' ? `:${attemptId}` : ''}`, maxOutputTokens: 1000, route,
          shouldContinue: async () => !(await this.isCancelled(runId, userId)) }),
    ]);

    totalTokens += bullResult.tokens + bearResult.tokens;

    const bullArgs = this.validateArguments(bullResult.data, validIds);
    const bearArgs = this.validateArguments(bearResult.data, validIds);

    // Persist arguments and debate records in parallel.
    await Promise.all([
      ...bullArgs.map((arg) =>
        this.multiAgentService.addArgument(userId, runId, {
          side: 'bull',
          round: 1,
          argument: arg.point,
          evidenceIds: arg.evidence_refs,
        }),
      ),
      ...bearArgs.map((arg) =>
        this.multiAgentService.addArgument(userId, runId, {
          side: 'bear',
          round: 1,
          argument: arg.point,
          evidenceIds: arg.evidence_refs,
        }),
      ),
      this.multiAgentService.addDebateRecord(userId, runId, {
        round: 1,
        speaker: 'bull',
        content: `${language === 'en' ? 'Round 1 — Bull case' : '【第一轮 - 多头论点】'}\n${bullArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}`,
        tokensUsed: bullResult.tokens,
      }),
      this.multiAgentService.addDebateRecord(userId, runId, {
        round: 1,
        speaker: 'bear',
        content: `${language === 'en' ? 'Round 1 — Bear case' : '【第一轮 - 空头论点】'}\n${bearArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}`,
        tokensUsed: bearResult.tokens,
      }),
    ]);

    // Rebuttal round: each side attacks the other's opening points.
    const bullRebuttalPrompt = `你是多头研究员。审查空头论点，仅在可引用证据支持时回应。每条回应必须引用下列证据 ID，不可把缺失数据当作事实。没有依据时返回空 arguments。

【可引用证据】
${evidenceText || '（无）'}

【缺失数据，不可引用】
${missingText || '（无）'}

【空头论点】
${bearArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}

【你的原始立场】
${bullArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}

请以 JSON 格式返回：
{
  "arguments": [
    { "point": "有证据支持的回应", "evidence_refs": ["上方证据 ID"] },
    ...
  ]
}`;

    const bearRebuttalPrompt = `你是空头研究员。审查多头论点，仅在可引用证据支持时回应。每条回应必须引用下列证据 ID，不可把缺失数据当作事实。没有依据时返回空 arguments。

【可引用证据】
${evidenceText || '（无）'}

【缺失数据，不可引用】
${missingText || '（无）'}

【多头论点】
${bullArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}

【你的原始立场】
${bearArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}

请以 JSON 格式返回：
{
  "arguments": [
    { "point": "有证据支持的回应", "evidence_refs": ["上方证据 ID"] },
    ...
  ]
}`;

    try {
      const [bullRebuttal, bearRebuttal] = await Promise.all([
        this.llmService.chatSlowJSON([{ role: 'system', content: languageInstruction(language) }, { role: 'user', content: bullRebuttalPrompt }], userId,
          { taskId: `analysis:${runId}`, purpose: `analysis-bull-rebuttal${attemptId && route?.mode === 'local' ? `:${attemptId}` : ''}`, maxOutputTokens: 1000, route,
            shouldContinue: async () => !(await this.isCancelled(runId, userId)) }),
        this.llmService.chatSlowJSON([{ role: 'system', content: languageInstruction(language) }, { role: 'user', content: bearRebuttalPrompt }], userId,
          { taskId: `analysis:${runId}`, purpose: `analysis-bear-rebuttal${attemptId && route?.mode === 'local' ? `:${attemptId}` : ''}`, maxOutputTokens: 1000, route,
            shouldContinue: async () => !(await this.isCancelled(runId, userId)) }),
      ]);

      totalTokens += bullRebuttal.tokens + bearRebuttal.tokens;

      const bullRebuttalArgs = this.validateArguments(bullRebuttal.data, validIds);
      const bearRebuttalArgs = this.validateArguments(bearRebuttal.data, validIds);

      await Promise.all([
        ...bullRebuttalArgs.map((arg) =>
          this.multiAgentService.addArgument(userId, runId, {
            side: 'bull',
            round: 2,
            argument: arg.point,
            evidenceIds: arg.evidence_refs,
          }),
        ),
        ...bearRebuttalArgs.map((arg) =>
          this.multiAgentService.addArgument(userId, runId, {
            side: 'bear',
            round: 2,
            argument: arg.point,
            evidenceIds: arg.evidence_refs,
          }),
        ),
        this.multiAgentService.addDebateRecord(userId, runId, {
          round: 2,
          speaker: 'bull',
          content: `${language === 'en' ? 'Round 2 — Bull response' : '【第二轮 - 多头反驳】'}\n${bullRebuttalArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}`,
          tokensUsed: bullRebuttal.tokens,
        }),
        this.multiAgentService.addDebateRecord(userId, runId, {
          round: 2,
          speaker: 'bear',
          content: `${language === 'en' ? 'Round 2 — Bear response' : '【第二轮 - 空头反驳】'}\n${bearRebuttalArgs.map((a, i) => `${i + 1}. ${a.point}`).join('\n')}`,
          tokensUsed: bearRebuttal.tokens,
        }),
      ]);
    } catch (rebuttalErr) {
      if (analysisErrorCode(rebuttalErr) === 'LLM_BUDGET_EXCEEDED') throw rebuttalErr;
      // Rebuttal is best-effort; opening round is the required minimum.
      this.logger.warn(`Debate round 2 failed: ${analysisErrorCode(rebuttalErr)}`);
    }

    return totalTokens;
  }

  /**
   * Run the critic stage: a free-text LLM call that critiques both sides'
   * weakest points. Output is stored verbatim as a round-3 debate record.
   * @returns tokens consumed.
   */
  private async runCritiquePhase(runId: string, userId: string, language: AnalysisLanguage = 'zh-CN',
    route?: ModelRoute, attemptId?: string): Promise<number> {
    const detail = await this.multiAgentService.getRun(userId, runId);
    const facts = detail.evidence.filter((item) => !this.isDataGap(item));
    const missing = detail.evidence.filter((item) => this.isDataGap(item));
    const evidenceText = this.formatEvidence(facts);
    const missingText = missing.map((item) => `- ${item.title}: ${item.content}`).join('\n');
    const supportedArguments = this.supportedArguments(detail.arguments, facts);

    const bullArgs = supportedArguments
      .filter((a) => a.side === 'bull')
      .map((a) => `[第${a.round}轮，证据ID: ${a.evidenceIds.join('、') || '无'}] ${a.argument}`)
      .join('\n');

    const bearArgs = supportedArguments
      .filter((a) => a.side === 'bear')
      .map((a) => `[第${a.round}轮，证据ID: ${a.evidenceIds.join('、') || '无'}] ${a.argument}`)
      .join('\n');

    const critiquePrompt = `你是一位资深投资评论家（Critic）。请阅读以下多空双方的辩论，尖锐地指出：

1. 多头论点中最薄弱的环节是什么？为什么？
2. 空头论点中最薄弱的环节是什么？为什么？
3. 双方都忽略了哪些关键风险或机会？
4. 双方在数据使用或推理中存在哪些逻辑漏洞？逐条核对其证据 ID 和下方原始数据，指出无依据或证据不足的断言。

请务必具体、犀利，不要和稀泥。

【原始可引用证据】
${evidenceText || '（无）'}

【缺失数据，不可作为事实】
${missingText || '（无）'}

【多头论点】
${bullArgs || '（无）'}

【空头论点】
${bearArgs || '（无）'}`;

    const result = await this.llmService.chatSlow([
      { role: 'system', content: languageInstruction(language) }, { role: 'user', content: critiquePrompt },
    ], userId, { taskId: `analysis:${runId}`, purpose: `analysis-critique${attemptId && route?.mode === 'local' ? `:${attemptId}` : ''}`, maxOutputTokens: 1000, route,
      shouldContinue: async () => !(await this.isCancelled(runId, userId)) });

    await this.multiAgentService.addDebateRecord(userId, runId, {
      round: 3,
      speaker: 'critic',
      content: result.content,
      tokensUsed: result.totalTokens,
    });

    return result.totalTokens;
  }

  /**
   * Run the final rating aggregation: build a prompt from evidence summary,
   * bull/bear arguments, critic output, and risk-gate results, then parse the
   * LLM's JSON response. Two post-hoc overrides are applied (defensive guards
   * that enforce business rules even if the LLM disobeys the prompt):
   *   - If any hard risk rule failed, the rating cannot exceed Hold.
   *   - If confidence is low, directional ratings (Buy/Sell/Strong Buy/Strong
   *     Sell) are downgraded to Watch.
   * Unknown ratings are clamped to Watch.
   * @returns tokens consumed by this LLM call.
   */
  private async runRatingPhase(
    runId: string,
    userId: string,
    ticker: string,
    hasHardFailure: boolean,
    rules: StrategyRule[],
    language: AnalysisLanguage = 'zh-CN',
    route?: ModelRoute,
    attemptId?: string,
  ): Promise<number> {
    const detail = await this.multiAgentService.getRun(userId, runId);

    const facts = detail.evidence.filter((item) => !this.isDataGap(item));
    const missing = detail.evidence.filter((item) => this.isDataGap(item));
    const criticalGaps = missing.filter((item) =>
      item.role === 'fundamental' || item.role === 'news');
    const criticalGapTitles = criticalGaps.map((item) => item.title);
    const implicitGaps: string[] = [];
    if (!facts.some((item) => item.role === 'fundamental'
      && item.evidenceType === 'financial')
      && !criticalGaps.some((item) => /财报|financial statements?/iu.test(item.title))) {
      implicitGaps.push(language === 'en' ? 'Missing financial statement evidence' : '财报证据缺失');
    }
    if (!facts.some((item) => item.role === 'news'
      && item.evidenceType === 'news')
      && !criticalGaps.some((item) => item.role === 'news')) {
      implicitGaps.push(language === 'en' ? 'Missing news evidence' : '新闻证据缺失');
    }
    criticalGapTitles.push(...implicitGaps);
    const missingText = [
      ...missing.map((item) => `- ${item.title}: ${item.content}`),
      ...implicitGaps.map((title) => `- ${title}: 本次没有可核实的证据记录。`),
    ].join('\n');
    const hasCriticalGap = criticalGapTitles.length > 0;
    // Cap factual evidence to fit the model context. Gaps remain separate.
    const evidenceSummary = facts
      .slice(0, 8)
      .map((e) => `- [${e.id}, ${e.role}] ${e.title}: ${e.content.slice(0, 150)}`)
      .join('\n');
    const supportedArguments = this.supportedArguments(detail.arguments, facts);

    const bullArgs = supportedArguments
      .filter((a) => a.side === 'bull')
      .map((a) => `- ${a.argument} [证据ID: ${a.evidenceIds.join('、') || '无'}]`)
      .join('\n');

    const bearArgs = supportedArguments
      .filter((a) => a.side === 'bear')
      .map((a) => `- ${a.argument} [证据ID: ${a.evidenceIds.join('、') || '无'}]`)
      .join('\n');

    const criticEntry = detail.debate.find((d) => d.speaker === 'critic');

    const riskSummary = detail.riskGate
      .map((r) => `- [${r.ruleType}] ${r.ruleName}: ${r.passed ? '通过' : '未通过'} (当前${r.currentValue ?? 'N/A'}/阈值${r.thresholdValue ?? 'N/A'})`)
      .join('\n');

    const hardRules = rules.filter((r) => r.ruleType === 'hard').map((r) => r.ruleName).join('、');

    const ratingPrompt = `你是一位资深投资组合经理（Portfolio Manager）。请基于以下所有信息，给出对 ${ticker} 的最终投资评级和操作建议。

【重要约束】
${hasHardFailure ? `- ⚠️ 风控硬规则（${hardRules}）未通过，评级不得为 Strong Buy 或 Buy，最高只能给 Hold。` : `- 风控硬规则全部通过。`}
- 如果置信度为 low，评级应为 Watch，而非 Buy 或 Sell。
- 如果缺少关键的财报、估值或新闻数据，仅可给 Watch/low，不得给目标价或方向性交易建议。
- 不得把缺失项、用户历史评级或模型推测当成已核实的事实。
- rating 可选值：Strong Buy / Buy / Hold / Sell / Strong Sell / Watch
- confidence 可选值：high / medium / low

【证据摘要】
${evidenceSummary || '（无可用事实）'}

【缺失数据，不可作为事实】
${missingText || '（无）'}

【多头论点】
${bullArgs || '（无）'}

【空头论点】
${bearArgs || '（无）'}

【Critic 评论】
${criticEntry?.content ?? '（无）'}

【风控检查结果】
${riskSummary}

请以 JSON 格式返回：
{
  "rating": "Buy/Hold/Sell/Watch/Strong Buy/Strong Sell",
  "confidence": "high/medium/low",
  "target_price": 数字或null,
  "action": "具体操作建议（如：逢低买入、持有观望、减仓一半等）",
  "aggregation_logic": "为什么是这个评级，综合了哪些因素",
  "key_uncertainty": "主要不确定性因素",
  "bull_summary": "多头要点总结（1-2句话）",
  "bear_summary": "空头要点总结（1-2句话）",
  "catalysts": "主要催化剂（用1) ... 2) ...编号）",
  "risks": "主要风险（用1) ... 2) ...编号）"
}`;

    const result = await this.llmService.chatSlowJSON([
      { role: 'system', content: languageInstruction(language) }, { role: 'user', content: ratingPrompt },
    ], userId, { taskId: `analysis:${runId}`, purpose: `analysis-rating${attemptId && route?.mode === 'local' ? `:${attemptId}` : ''}`, maxOutputTokens: 1000, route,
      shouldContinue: async () => !(await this.isCancelled(runId, userId)) });

    const data = result.data as Record<string, unknown>;

    let rating = String(data.rating ?? 'Watch').trim() as AgentRating;
    let confidence = String(data.confidence ?? 'low').trim().toLowerCase() as AgentConfidence;

    // Clamp unknown ratings to Watch as a safe default.
    const validRatings: AgentRating[] = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell', 'Watch'];
    if (!validRatings.includes(rating)) {
      rating = 'Watch';
    }
    if (!['high', 'medium', 'low'].includes(confidence)) {
      confidence = 'low';
    }

    // Hard override #1: hard risk-gate failure caps rating at Hold.
    if (hasHardFailure && (rating === 'Buy' || rating === 'Strong Buy')) {
      rating = 'Hold';
    }
    // Hard override #2: low confidence forbids directional calls.
    if (confidence === 'low' && (rating === 'Buy' || rating === 'Sell' || rating === 'Strong Buy' || rating === 'Strong Sell')) {
      rating = 'Watch';
    }
    if (hasCriticalGap) {
      rating = 'Watch';
      confidence = 'low';
    }

    const gapSummary = [...new Set([
      ...missing.map((item) => item.title),
      ...implicitGaps,
    ])].join(language === 'en' ? '; ' : '、');
    const modelUncertainty = String(data.key_uncertainty ?? '').trim();
    const uncertaintySuffix = modelUncertainty && modelUncertainty !== '无'
      ? `${language === 'en' ? '; ' : '；'}${modelUncertainty}` : '';
    const keyUncertainty = gapSummary
      ? `${language === 'en' ? 'Missing data: ' : '缺失数据：'}${gapSummary}${uncertaintySuffix}`
      : modelUncertainty || undefined;
    const modelLogic = String(data.aggregation_logic ?? '').trim();
    const aggregationLogic = hasCriticalGap
      ? `${language === 'en' ? 'Watch only; critical data is missing: ' : '当前仅能观察，缺失关键数据：'}${gapSummary}${modelLogic ? `; ${modelLogic}` : ''}`
      : modelLogic || undefined;
    const targetPrice = !hasCriticalGap && data.target_price !== null
      && data.target_price !== undefined ? Number(data.target_price) : undefined;

    await this.multiAgentService.saveRating(userId, runId, {
      ticker,
      rating,
      confidence,
      targetPrice: targetPrice !== undefined && Number.isFinite(targetPrice) && targetPrice > 0
        ? targetPrice : undefined,
      action: hasCriticalGap
        ? language === 'en' ? `Insufficient evidence. Defer directional trades and reassess after obtaining: ${gapSummary}.`
          : `数据不足，暂缓方向性交易；补齐${gapSummary}后复评。`
        : String(data.action ?? ''),
      aggregationLogic,
      keyUncertainty,
      bullSummary: data.bull_summary ? String(data.bull_summary) : undefined,
      bearSummary: data.bear_summary ? String(data.bear_summary) : undefined,
      catalysts: data.catalysts ? String(data.catalysts) : undefined,
      risks: data.risks ? String(data.risks) : undefined,
    });

    return result.tokens;
  }

  /** Free, deterministic summary. This is a data/rule review, never a simulated AI opinion. */
  private async runBasicRatingPhase(
    runId: string, userId: string, ticker: string, language: AnalysisLanguage,
  ): Promise<number> {
    const detail = await this.multiAgentService.getRun(userId, runId);
    const en = language === 'en';
    const facts = detail.evidence.filter((item) => !this.isDataGap(item));
    const gaps = detail.evidence.filter((item) => this.isDataGap(item));
    const hardFailures = detail.riskGate.filter((item) => item.ruleType === 'hard' && !item.passed).length;
    await this.multiAgentService.saveRating(userId, runId, {
      ticker, rating: 'Watch', confidence: 'low',
      action: en ? 'Observe the available data and review risk limits. No directional trade is recommended by basic mode.'
        : '查看现有数据并复核风险限制。基础模式不提供方向性交易建议。',
      aggregationLogic: en
        ? `Free basic analysis used ${facts.length} evidence records and ${detail.riskGate.length} local risk checks (${hardFailures} hard-rule failures). It did not call an LLM or estimate a target price. Watch/low describes limited analytical coverage, not a forecast.`
        : `免费基础分析使用 ${facts.length} 条证据和 ${detail.riskGate.length} 条本地风险检查（${hardFailures} 条硬规则未通过）。未调用大模型，也未预测目标价。观望/低置信度表示分析覆盖有限，不是行情预测。`,
      keyUncertainty: gaps.length
        ? gaps.map((item) => item.title).join(en ? '; ' : '；')
        : en ? 'Basic mode does not assess company valuation or future returns.' : '基础模式未评估企业估值或未来收益。',
      risks: en ? `${hardFailures} hard risk rules failed. Review the local risk gate details.`
        : `${hardFailures} 条风险硬规则未通过，请查看本地风控明细。`,
    });
    return 0;
  }

  /** Format saved facts with their citation IDs for debate and critique. */
  private formatEvidence(evidence: AgentEvidence[]): string {
    return evidence.map((item, index) => [
      `证据 ${index + 1} [ID: ${item.id}, ${item.role}/${item.evidenceType}] ${item.title}`,
      `内容: ${item.content}`,
      `来源: ${item.sourceName ?? '未知'}`,
    ].join('\n')).join('\n\n');
  }

  private isDataGap(item: AgentEvidence): boolean {
    return item.sourceName === 'Data Unavailable';
  }

  /** Ignore injected or stale arguments whose IDs are absent from this run. */
  private supportedArguments(
    argumentsForRun: BullBearArgument[],
    facts: AgentEvidence[],
  ): BullBearArgument[] {
    const validIds = new Set(facts.map((item) => item.id));
    return argumentsForRun.flatMap((argument) => {
      const references = [...new Set(argument.evidenceIds)];
      const valid = references.filter((id) => validIds.has(id));
      if (valid.length !== references.length) {
        this.logger.warn(`Ignored invalid stored evidence references for argument ${argument.id}`);
      }
      return valid.length > 0 ? [{ ...argument, evidenceIds: valid }] : [];
    });
  }

  /** Remove nonexistent citations and discard claims with no saved fact. */
  private validateArguments(
    data: unknown,
    validIds: Set<string>,
  ): Array<{ point: string; evidence_refs: string[] }> {
    return this.extractArguments(data).flatMap((argument) => {
      const references = [...new Set(argument.evidence_refs)];
      const valid = references.filter((id) => validIds.has(id));
      const invalid = references.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        this.logger.warn(`Dropped invalid evidence references: ${invalid.join(', ')}`);
      }
      if (valid.length === 0) {
        this.logger.warn(`Dropped unsupported debate argument: ${argument.point}`);
        return [];
      }
      return [{ point: argument.point, evidence_refs: valid }];
    });
  }

  /**
   * Defensive parser for the bull/bear JSON output. The LLM is asked for
   * `{ arguments: [{ point, evidence_refs }] }` but may return malformed JSON
   * or missing fields; this helper returns an empty array on any shape mismatch
   * rather than throwing.
   */
  private extractArguments(data: unknown): Array<{ point: string; evidence_refs: string[] }> {
    if (!data || typeof data !== 'object') return [];
    const obj = data as Record<string, unknown>;
    const args = obj.arguments;
    if (!Array.isArray(args)) return [];

    return args
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({
        point: String(a.point ?? ''),
        evidence_refs: Array.isArray(a.evidence_refs)
          ? (a.evidence_refs as string[]).map(String)
          : [],
      }))
      .filter((a) => a.point.length > 0);
  }
}
