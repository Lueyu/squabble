/**
 * PipelineService — 编排单次股票运行（agent run）的异步多智能体分析流水线。
 *
 * 职责边界：
 *  - 只负责阶段推进、取消检查、状态写入与完成通知；证据采集、LLM 调用、
 *    持久化分别委托 EvidenceService / LlmService / MultiAgentService。
 *
 * 阶段顺序（见 runPipeline）：
 *   0. setStatus('fetching') — 标记运行进行中，记录 startedAt。
 *   1. 证据采集：经 EvidenceService.collectEvidence 拉取实时行情 +
 *      组合/关注列表行，写入 agent_evidence。
 *   2. 多空辩论：两次并行 LLM 调用（bull + bear）生成开局论点；再两次并行
 *      调用生成反驳。每侧输出按 JSON 解析并持久化到 bull_bear_arguments 与
 *      debate_records。第二轮失败不致命（仅记 warning）。
 *   3. 评论：单次 LLM 调用（chatSlow，自由文本），批评双方最薄弱的论点，
 *      由 `critic` 以第三轮辩论记录形式保存。
 *   4. 风控闸：用用户的硬/软策略规则对照当前组合评估（无 LLM）。
 *      `hard` 规则不过会封顶最终评级。
 *   5. 评级聚合：最后一次 LLM 调用，输入为证据摘要 + 多/空/评论 + 风控摘要，
 *      输出 JSON 评级对象。保存前经两道硬性覆写（见 runRatingPhase）。
 *
 * 第 5 阶段后运行进入 `awaiting_human`，HTTP 客户端轮询直至人工
 * 批准/修改/驳回。
 *
 * 取消：每个阶段之间调用 `isCancelled` 重读运行行；用户一旦取消，
 * 流水线直接退出，不推进状态。
 *
 * 完成通知：成功与失败都会经 `notifyComplete` 触发回调（BatchService 注册），
 * 让队列释放并发槽位并取出下一项。
 *
 * Token 计量：tokensUsed 跨 LLM 调用累计，最终写回运行行用于成本核算。
 *
 * 上下游：
 *  - 上游：MultiAgentController.startRun、BatchService.processQueue。
 *  - 下游：LlmService、EvidenceService、PortfolioContextService、
 *    MultiAgentService（状态/证据/论点/辩论/风控/评级/报告/审计）。
 *  - 复用 analysis-report 的 languageInstruction/englishRuleName/
 *    safeAnalysisError/analysisErrorCode。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
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
import {
  languageInstruction,
  englishRuleName,
  safeAnalysisError,
  analysisErrorCode,
} from './analysis-report';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  /** 任一运行结束（成功、失败或取消）时触发的回调集合。
   *  BatchService 注册一个用于释放并发槽位。 */
  private completeCallbacks: Array<(runId: string, userId: string, mode: AgentRunMode) => void> =
    [];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly llmService: LlmService,
    private readonly evidenceService: EvidenceService,
    private readonly portfolioContextService: PortfolioContextService,
    private readonly multiAgentService: MultiAgentService,
  ) {}

  /**
   * 注册运行完成（任意终态）时调用的回调。BatchService 用它释放并发槽位
   * 并处理队列。
   * @param cb 回调，接收 runId、userId 与该运行的 mode。
   */
  onRunComplete(cb: (runId: string, userId: string, mode: AgentRunMode) => void): void {
    this.completeCallbacks.push(cb);
  }

  /**
   * 触发全部已注册的完成回调。每个回调都包在 try/catch 里，
   * 单个坏监听者不会影响其他监听者或流水线本身。
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
   * fire-and-forget 的流水线入口。返回的 promise 故意不被调用方 await
   * （controller 立即返回）；所有错误都在此处记录。
   * @param runId 要运行的 agent_runs.id。
   * @param userId 所有者，用于按所有者隔离的数据库写入与取消检查。
   */
  startPipeline(runId: string, userId: string, queuedMode?: AgentRunMode): void {
    void this.runPipeline(runId, userId, queuedMode).catch((err) => {
      this.logger.error(`Pipeline failed for run ${runId}: ${analysisErrorCode(err)}`);
    });
  }

  /**
   * 流水线内部驱动：按顺序跑全部五个阶段，阶段之间检查取消。
   * 出错时把运行转为 `failed` 并写审计日志，随后仍触发 notifyComplete，
   * 让批量队列可以继续推进。
   */
  private async runPipeline(
    runId: string,
    userId: string,
    queuedMode?: AgentRunMode,
  ): Promise<void> {
    // 阶段间共享的累计 token 与运行元信息
    let tokensUsed = 0;
    let mode: AgentRunMode | null = null;
    let language: AnalysisLanguage = 'zh-CN';
    const addTokens = (n: number): void => {
      tokensUsed += n;
    };

    try {
      // 第 0 步：读取运行行，确定模式/语言；失败过的运行先清理残留产物
      const runDetail = await this.multiAgentService.getRun(userId, runId);
      mode = runDetail.runMode;
      language = runDetail.language ?? 'zh-CN';
      if (await this.isCancelled(runId, userId)) return;
      if (runDetail.status === 'failed')
        await this.multiAgentService.resetFailedRunArtifacts(userId, runId);
      await this.setStatus(runId, userId, 'fetching', {
        startedAt: new Date(),
        errorMessage: null,
      });
      const ticker = runDetail.ticker;
      const useLlm = await this.llmService.isConfigured(userId);
      const execution = useLlm ? await this.llmService.getExecutionInfo(userId) : null;

      if (await this.isCancelled(runId, userId)) return;

      // 第 1 阶段：证据采集（组合快照 + 三路证据，写入 agent_evidence）
      this.logger.log(`Phase 1: Fetching evidence for ${ticker}`);
      const portfolio = await this.portfolioContextService.getPortfolioContext(userId);
      const evidence = await this.evidenceService.collectEvidence(
        ticker,
        userId,
        portfolio,
        language,
      );

      // 持久化事实与显式缺口；辩论引用只允许使用这里返回的 ID
      const savedEvidence = await this.multiAgentService.addEvidence(
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
        })),
      );

      if (await this.isCancelled(runId, userId)) return;

      // 第 2 阶段：多空辩论（未配置 LLM 时直接跳过，token 计 0）
      this.logger.log(`Phase 2: Bull/Bear debate for ${ticker}`);
      if (useLlm) await this.setStatus(runId, userId, 'debating');
      const debateTokens = useLlm
        ? await this.runDebatePhase(runId, userId, ticker, savedEvidence, language)
        : 0;
      addTokens(debateTokens);

      if (await this.isCancelled(runId, userId)) return;

      // 第 3 阶段：评论（critic）
      this.logger.log(`Phase 3: Critique for ${ticker}`);
      if (useLlm) await this.setStatus(runId, userId, 'critiquing');
      const critiqueTokens = useLlm ? await this.runCritiquePhase(runId, userId, language) : 0;
      addTokens(critiqueTokens);

      if (await this.isCancelled(runId, userId)) return;

      // 第 4 阶段：风控闸（无 LLM，纯规则对照组合快照）
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
          detail:
            language === 'en'
              ? r.currentValue === null
                ? 'This rule could not be verified from the available data or configured threshold.'
                : `Measured value: ${r.currentValue}. Configured threshold: ${r.thresholdValue ?? 'unavailable'}. Result: ${r.passed ? 'passed' : 'failed'}.`
              : r.detail,
          suggestedAction:
            language === 'en'
              ? r.passed
                ? 'No violation was detected by this check.'
                : 'Review the configured rule and missing evidence before trading.'
              : r.suggestedAction,
        })),
      );

      // 硬规则失败不会中止流水线，但会封顶最终评级
      // （不允许 Buy / Strong Buy）。
      const hasHardFailure = riskResults.some((r) => r.ruleType === 'hard' && !r.passed);

      if (await this.isCancelled(runId, userId)) return;

      // 第 5 阶段：评级聚合（LLM 模式 / basic 兜底模式二选一），随后保存报告
      this.logger.log(`Phase 5: Rating aggregation for ${ticker}`);
      const ratingTokens = useLlm
        ? await this.runRatingPhase(runId, userId, ticker, hasHardFailure, rules, language)
        : await this.runBasicRatingPhase(runId, userId, ticker, language);
      addTokens(ratingTokens);
      if (await this.isCancelled(runId, userId)) return;
      await this.multiAgentService.savePipelineReport(
        userId,
        runId,
        useLlm ? 'llm' : 'basic',
        execution,
      );

      // 终态：等待人工决策；记录完成时间与 token 总量，写审计日志
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
      // 失败收尾：经 safeAnalysisError 得到用户可见错误文案，
      // 状态转 failed 并写 run_failed 审计日志；状态更新自身失败只记日志
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
      // 队列已按模式预留槽位。即使首次数据库读取失败、读不到运行模式，
      // 也要用 queuedMode 兜底释放槽位，否则队列会卡死。
      const completedMode = queuedMode ?? mode;
      if (completedMode) this.notifyComplete(runId, userId, completedMode);
    }
  }

  /**
   * 按所有者隔离的取消检查。重读运行行；当且仅当行存在且状态为
   * 'cancelled' 时返回 true。
   */
  private async isCancelled(runId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)));
    return row?.status === 'cancelled';
  }

  /**
   * 更新运行行的状态与可选元数据（startedAt、completedAt、errorMessage、
   * tokensUsed）。始终按所有者隔离。
   */
  private async setStatus(
    runId: string,
    userId: string,
    status: AgentRunStatus,
    extra?: {
      startedAt?: Date;
      completedAt?: Date;
      errorMessage?: string | null;
      tokensUsed?: number;
    },
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
   * 跑多空辩论：两份开局论点（并行 LLM 调用），随后两份反驳（并行 LLM 调用）。
   * 反驳失败只记日志，不会让整个运行失败 —— 开局轮已足够。
   * @returns 全部辩论 LLM 调用消耗的 token 总数。
   */
  private async runDebatePhase(
    runId: string,
    userId: string,
    ticker: string,
    evidence: AgentEvidence[],
    language: AnalysisLanguage = 'zh-CN',
  ): Promise<number> {
    // 拆分证据：事实 vs 显式缺口；缺口单独列出且不可被 LLM 引用
    const facts = evidence.filter((item) => !this.isDataGap(item));
    const missing = evidence.filter((item) => this.isDataGap(item));
    const evidenceText = this.formatEvidence(facts);
    const missingText = missing.map((item) => `- ${item.title}: ${item.content}`).join('\n');
    const validIds = new Set(facts.map((item) => item.id));
    let totalTokens = 0;

    // 输出语言由运行行决定；JSON 键与引用 ID 保持稳定。
    // 下方 prompt 模板为冻结字符串（用户可见/模型行为相关），一字不改。
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

    // 开局轮：bull 与 bear 用 "slow"（pro）模型并行执行。
    const [bullResult, bearResult] = await Promise.all([
      this.llmService.chatSlowJSON(
        [
          { role: 'system', content: languageInstruction(language) },
          { role: 'user', content: bullPrompt },
        ],
        userId,
        { taskId: `analysis:${runId}`, purpose: 'analysis-bull-opening', maxOutputTokens: 1000 },
      ),
      this.llmService.chatSlowJSON(
        [
          { role: 'system', content: languageInstruction(language) },
          { role: 'user', content: bearPrompt },
        ],
        userId,
        { taskId: `analysis:${runId}`, purpose: 'analysis-bear-opening', maxOutputTokens: 1000 },
      ),
    ]);

    totalTokens += bullResult.tokens + bearResult.tokens;

    // 校验双方论点：只保留引用了有效证据 ID 的条目
    const bullArgs = this.validateArguments(bullResult.data, validIds);
    const bearArgs = this.validateArguments(bearResult.data, validIds);

    // 并行持久化论点与辩论记录。
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

    // 反驳轮：双方互相攻击对方的开局论点（prompt 模板冻结）。
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
        this.llmService.chatSlowJSON(
          [
            { role: 'system', content: languageInstruction(language) },
            { role: 'user', content: bullRebuttalPrompt },
          ],
          userId,
          { taskId: `analysis:${runId}`, purpose: 'analysis-bull-rebuttal', maxOutputTokens: 1000 },
        ),
        this.llmService.chatSlowJSON(
          [
            { role: 'system', content: languageInstruction(language) },
            { role: 'user', content: bearRebuttalPrompt },
          ],
          userId,
          { taskId: `analysis:${runId}`, purpose: 'analysis-bear-rebuttal', maxOutputTokens: 1000 },
        ),
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
      // 反驳轮是尽力而为；开局轮是必需的最低要求。
      this.logger.warn(`Debate round 2 failed: ${analysisErrorCode(rebuttalErr)}`);
    }

    return totalTokens;
  }

  /**
   * 评论阶段：一次自由文本 LLM 调用，批评双方最薄弱的论点。
   * 输出原样保存为第 3 轮辩论记录。
   * @returns 消耗的 token 数。
   */
  private async runCritiquePhase(
    runId: string,
    userId: string,
    language: AnalysisLanguage = 'zh-CN',
  ): Promise<number> {
    // 重建证据/论点上下文：事实与缺口分开，论点只保留有证据支持的
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

    // 评论 prompt 模板为冻结字符串，一字不改
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

    const result = await this.llmService.chatSlow(
      [
        { role: 'system', content: languageInstruction(language) },
        { role: 'user', content: critiquePrompt },
      ],
      userId,
      { taskId: `analysis:${runId}`, purpose: 'analysis-critique', maxOutputTokens: 1000 },
    );

    // 评论输出原样作为第 3 轮 critic 辩论记录保存
    await this.multiAgentService.addDebateRecord(userId, runId, {
      round: 3,
      speaker: 'critic',
      content: result.content,
      tokensUsed: result.totalTokens,
    });

    return result.totalTokens;
  }

  /**
   * 最终评级聚合：用证据摘要、多空论点、评论输出与风控结果拼 prompt，
   * 解析 LLM 的 JSON 响应。之后套用两道事后覆写（防御性闸门，即使 LLM
   * 不遵守 prompt 也强制业务规则）：
   *   - 任一硬风控规则失败时，评级不得高于 Hold。
   *   - 置信度为 low 时，方向性评级（Buy/Sell/Strong Buy/Strong Sell）
   *     降级为 Watch。
   * 未知评级一律收敛为 Watch。
   * @returns 本次 LLM 调用消耗的 token 数。
   */
  private async runRatingPhase(
    runId: string,
    userId: string,
    ticker: string,
    hasHardFailure: boolean,
    rules: StrategyRule[],
    language: AnalysisLanguage = 'zh-CN',
  ): Promise<number> {
    const detail = await this.multiAgentService.getRun(userId, runId);

    // 缺口盘点：显式缺口 + "隐式缺口"（既没有证据、也没有显式缺口记录时补记）
    const facts = detail.evidence.filter((item) => !this.isDataGap(item));
    const missing = detail.evidence.filter((item) => this.isDataGap(item));
    const criticalGaps = missing.filter(
      (item) => item.role === 'fundamental' || item.role === 'news',
    );
    const criticalGapTitles = criticalGaps.map((item) => item.title);
    const implicitGaps: string[] = [];
    if (
      !facts.some((item) => item.role === 'fundamental' && item.evidenceType === 'financial') &&
      !criticalGaps.some((item) => /财报|financial statements?/iu.test(item.title))
    ) {
      implicitGaps.push(
        language === 'en' ? 'Missing financial statement evidence' : '财报证据缺失',
      );
    }
    if (
      !facts.some((item) => item.role === 'news' && item.evidenceType === 'news') &&
      !criticalGaps.some((item) => item.role === 'news')
    ) {
      implicitGaps.push(language === 'en' ? 'Missing news evidence' : '新闻证据缺失');
    }
    criticalGapTitles.push(...implicitGaps);
    const missingText = [
      ...missing.map((item) => `- ${item.title}: ${item.content}`),
      ...implicitGaps.map((title) => `- ${title}: 本次没有可核实的证据记录。`),
    ].join('\n');
    const hasCriticalGap = criticalGapTitles.length > 0;
    // 事实证据截断到 8 条以适配模型上下文；缺口单独列出。
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
      .map(
        (r) =>
          `- [${r.ruleType}] ${r.ruleName}: ${r.passed ? '通过' : '未通过'} (当前${r.currentValue ?? 'N/A'}/阈值${r.thresholdValue ?? 'N/A'})`,
      )
      .join('\n');

    const hardRules = rules
      .filter((r) => r.ruleType === 'hard')
      .map((r) => r.ruleName)
      .join('、');

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

    const result = await this.llmService.chatSlowJSON(
      [
        { role: 'system', content: languageInstruction(language) },
        { role: 'user', content: ratingPrompt },
      ],
      userId,
      { taskId: `analysis:${runId}`, purpose: 'analysis-rating', maxOutputTokens: 1000 },
    );

    const data = result.data as Record<string, unknown>;

    // 解析评级与置信度，非法值收敛到安全默认（Watch/low）
    let rating = String(data.rating ?? 'Watch').trim() as AgentRating;
    let confidence = String(data.confidence ?? 'low')
      .trim()
      .toLowerCase() as AgentConfidence;

    // 未知评级收敛为 Watch（安全默认）。
    const validRatings: AgentRating[] = [
      'Strong Buy',
      'Buy',
      'Hold',
      'Sell',
      'Strong Sell',
      'Watch',
    ];
    if (!validRatings.includes(rating)) {
      rating = 'Watch';
    }
    if (!['high', 'medium', 'low'].includes(confidence)) {
      confidence = 'low';
    }

    // 硬性覆写 1：硬风控规则失败时评级封顶 Hold。
    if (hasHardFailure && (rating === 'Buy' || rating === 'Strong Buy')) {
      rating = 'Hold';
    }
    // 硬性覆写 2：低置信度禁止方向性结论。
    if (
      confidence === 'low' &&
      (rating === 'Buy' || rating === 'Sell' || rating === 'Strong Buy' || rating === 'Strong Sell')
    ) {
      rating = 'Watch';
    }
    if (hasCriticalGap) {
      // 存在关键缺口：强制 Watch/low，目标价与方向性建议一并不予产出
      rating = 'Watch';
      confidence = 'low';
    }

    // 关键缺口存在时，把缺口清单写进 keyUncertainty / aggregationLogic /
    // action，保证用户能看到"为什么只有观望"
    const gapSummary = [...new Set([...missing.map((item) => item.title), ...implicitGaps])].join(
      language === 'en' ? '; ' : '、',
    );
    const modelUncertainty = String(data.key_uncertainty ?? '').trim();
    const uncertaintySuffix =
      modelUncertainty && modelUncertainty !== '无'
        ? `${language === 'en' ? '; ' : '；'}${modelUncertainty}`
        : '';
    const keyUncertainty = gapSummary
      ? `${language === 'en' ? 'Missing data: ' : '缺失数据：'}${gapSummary}${uncertaintySuffix}`
      : modelUncertainty || undefined;
    const modelLogic = String(data.aggregation_logic ?? '').trim();
    const aggregationLogic = hasCriticalGap
      ? `${language === 'en' ? 'Watch only; critical data is missing: ' : '当前仅能观察，缺失关键数据：'}${gapSummary}${modelLogic ? `; ${modelLogic}` : ''}`
      : modelLogic || undefined;
    const targetPrice =
      !hasCriticalGap && data.target_price !== null && data.target_price !== undefined
        ? Number(data.target_price)
        : undefined;

    await this.multiAgentService.saveRating(userId, runId, {
      ticker,
      rating,
      confidence,
      targetPrice:
        targetPrice !== undefined && Number.isFinite(targetPrice) && targetPrice > 0
          ? targetPrice
          : undefined,
      action: hasCriticalGap
        ? language === 'en'
          ? `Insufficient evidence. Defer directional trades and reassess after obtaining: ${gapSummary}.`
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

  /**
   * 免费确定性的摘要评级。这是数据/规则复核，绝不是模拟的 AI 观点。
   * 不调用 LLM：固定 Watch/low，文案中说明覆盖范围有限、非行情预测。
   */
  private async runBasicRatingPhase(
    runId: string,
    userId: string,
    ticker: string,
    language: AnalysisLanguage,
  ): Promise<number> {
    const detail = await this.multiAgentService.getRun(userId, runId);
    const en = language === 'en';
    const facts = detail.evidence.filter((item) => !this.isDataGap(item));
    const gaps = detail.evidence.filter((item) => this.isDataGap(item));
    const hardFailures = detail.riskGate.filter(
      (item) => item.ruleType === 'hard' && !item.passed,
    ).length;
    await this.multiAgentService.saveRating(userId, runId, {
      ticker,
      rating: 'Watch',
      confidence: 'low',
      action: en
        ? 'Observe the available data and review risk limits. No directional trade is recommended by basic mode.'
        : '查看现有数据并复核风险限制。基础模式不提供方向性交易建议。',
      aggregationLogic: en
        ? `Free basic analysis used ${facts.length} evidence records and ${detail.riskGate.length} local risk checks (${hardFailures} hard-rule failures). It did not call an LLM or estimate a target price. Watch/low describes limited analytical coverage, not a forecast.`
        : `免费基础分析使用 ${facts.length} 条证据和 ${detail.riskGate.length} 条本地风险检查（${hardFailures} 条硬规则未通过）。未调用大模型，也未预测目标价。观望/低置信度表示分析覆盖有限，不是行情预测。`,
      keyUncertainty: gaps.length
        ? gaps.map((item) => item.title).join(en ? '; ' : '；')
        : en
          ? 'Basic mode does not assess company valuation or future returns.'
          : '基础模式未评估企业估值或未来收益。',
      risks: en
        ? `${hardFailures} hard risk rules failed. Review the local risk gate details.`
        : `${hardFailures} 条风险硬规则未通过，请查看本地风控明细。`,
    });
    return 0;
  }

  /** 为辩论与评论格式化已保存事实，附上引用 ID。 */
  private formatEvidence(evidence: AgentEvidence[]): string {
    return evidence
      .map((item, index) =>
        [
          `证据 ${index + 1} [ID: ${item.id}, ${item.role}/${item.evidenceType}] ${item.title}`,
          `内容: ${item.content}`,
          `来源: ${item.sourceName ?? '未知'}`,
        ].join('\n'),
      )
      .join('\n\n');
  }

  /** 缺口判定：sourceName 为 'Data Unavailable' 的条目即显式数据缺口。 */
  private isDataGap(item: AgentEvidence): boolean {
    return item.sourceName === 'Data Unavailable';
  }

  /** 忽略引用了本运行不存在证据 ID 的（注入或过期）论点。 */
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

  /** 剔除不存在的引用，丢弃没有任何已保存事实支撑的论点。 */
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
   * 对多空 JSON 输出的防御性解析。LLM 被要求返回
   * `{ arguments: [{ point, evidence_refs }] }`，但可能返回畸形 JSON 或缺字段；
   * 形状不符时返回空数组而不是抛错。
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
