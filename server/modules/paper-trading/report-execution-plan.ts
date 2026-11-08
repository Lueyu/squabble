import { z } from 'zod';
import type { ReportExecutionPlan, ReportExecutionPlanInput } from '../../../shared/report-execution-plan.interface';
import type { StrategyValidationIssue } from '../../../shared/user-investment-strategy.interface';
import { normalizeStrategyDraft, previewStrategy } from './user-investment-strategy.rules';

export const REPORT_EXECUTION_SECTION_ID = 'execution-strategy';
const proposalLabel = 'AI 建议 / AI proposal: ';
const inputSchema = z.object({
  schemaVersion: z.literal(1), parameterOrigin: z.enum(['ai_proposed', 'system_observation']),
  strategy: z.record(z.string(), z.unknown()),
  evidenceIds: z.array(z.string().trim().min(1).max(200)).max(40),
  gaps: z.array(z.string().trim().min(1).max(2000)).max(40),
  noTradeReason: z.string().trim().min(1).max(2000).optional(),
}).strict();

/** Numeric evidence binds suggested parameters to exact proposal text; it does not prove market facts. */
export function parseReportExecutionPlan(raw: unknown, validEvidenceIds: Set<string>, now = new Date()): ReportExecutionPlan {
  // Archived derived fields are never trusted when a published plan is revalidated.
  let input = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { readiness: _readiness, preview: _preview, ...proposed } = raw as Record<string, unknown>;
    input = proposed;
  }
  const decoded = inputSchema.parse(input);
  const parsed: ReportExecutionPlanInput = { ...decoded, strategy: normalizeStrategyDraft(decoded.strategy) };
  const observation = parsed.parameterOrigin === 'system_observation';
  if (observation && (!parsed.noTradeReason || !parsed.strategy.entries.length || parsed.strategy.limits
    || parsed.evidenceIds.length || parsed.strategy.entries.some(entry => entry.directive || entry.mandateRule || entry.mandateReviewedText)))
    throw new Error('SYSTEM_OBSERVATION_EXECUTION_FORBIDDEN');
  if (parsed.evidenceIds.some(id => !validEvidenceIds.has(id))) throw new Error('REPORT_EXECUTION_EVIDENCE_INVALID');
  if (parsed.strategy.entries.some(entry => entry.mandateRule !== undefined || entry.mandateReviewedText !== undefined))
    throw new Error('REPORT_EXECUTION_LEGACY_RULE_UNSUPPORTED');
  const strategy = normalizeStrategyDraft({ ...parsed.strategy, entries: parsed.strategy.entries.map(entry => {
    const text = observation || /AI\s*(?:建议|提议|proposal|proposed)/iu.test(entry.text) ? entry.text : proposalLabel + entry.text;
    return { ...entry, text, sourceKeys: [], ...(entry.directive ? { directive: { ...entry.directive, semanticAuthorized: false,
      reviewedText: entry.directive.reviewedText === entry.text ? text : entry.directive.reviewedText } } : {}) };
  }) });
  const preview = previewStrategy(strategy, [], 1, now);
  const gaps = [...new Set(parsed.gaps)];
  // Existing gap text is preserved; all additional rule details remain available in preview.issues.
  const appendGap = (gap: string) => { if (gaps.length < 40 && !gaps.includes(gap)) gaps.push(gap); };
  for (const issue of preview.issues) appendGap(`${issue.code}: ${issue.message['zh-CN']} / ${issue.message.en}`);
  const hasProposedDirective = strategy.entries.some(entry => entry.directive !== undefined);
  const noTrade = Boolean(parsed.noTradeReason && !hasProposedDirective);
  if (!noTrade) {
    if (!parsed.evidenceIds.length) appendGap('缺少可核对的研究依据。 / No verifiable research evidence was cited.');
    for (const entry of preview.entries.filter(entry => entry.state === 'observation' || entry.state === 'expired'))
      appendGap(`${entry.id}: ${entry.explanation['zh-CN']} / ${entry.explanation.en}`);
    if (!preview.directives.length && !preview.issues.length && !preview.entries.length)
      appendGap('没有可执行建议，也未说明不交易原因。 / No executable proposal or explicit no-trade reason was supplied.');
  }
  if (gaps.length) {
    const issue: StrategyValidationIssue = { code: 'REPORT_PLAN_GAPS', entryIds: strategy.entries.map(entry => entry.id), severity: 'error',
      message: { en: 'Resolve the report plan gaps before applying any proposed action.', 'zh-CN': '应用建议前请先补齐报告策略缺口。' } };
    preview.issues.push(issue); preview.canConfirm = false;
  }
  const readiness = noTrade ? 'no_trade' : preview.directives.length > 0 && parsed.evidenceIds.length > 0
    && gaps.length === 0 && !preview.issues.some(issue => issue.severity === 'error') ? 'ready' : 'needs_info';
  const plan: ReportExecutionPlan = { ...parsed, strategy, evidenceIds: [...new Set(parsed.evidenceIds)], gaps, readiness, preview };
  // The exact immutable section must fit the same readable-content budget used by report imports.
  if (['en', 'zh-CN'].some(language => renderReportExecutionPlan(plan, language).length > 12000))
    throw new Error('REPORT_EXECUTION_TOO_LONG');
  return plan;
}

/** A failed proposal remains actionable as an observation; this never fabricates AI judgment or order parameters. */
export function createReportObservationPlan(reason: 'missing' | 'invalid', nextReviewCondition: string,
  language: string, timezone: string, now = new Date()): ReportExecutionPlan {
  const en = language === 'en';
  const failure = reason === 'invalid'
    ? (en ? 'The AI execution proposal failed validation.' : 'AI 执行策略未通过校验。')
    : (en ? 'The report did not return an AI execution proposal.' : '报告没有返回 AI 执行策略。');
  const body = en ? `${failure} This system observation preserves the follow-up task; it is not an AI recommendation to hold or trade. No automatic buy or sell instruction is included.`
    : `${failure} 系统保留以下待核查事项，不代表 AI 建议持有或买卖，不含自动交易指令。`;
  const next = nextReviewCondition.trim().slice(0, 1000);
  const text = next ? `${en ? 'Next check recorded in the report' : '报告记录的下一次核查条件'}: ${next}`
    : (en ? 'Check the next daily report for validated conditions, quantities and risk limits before authorizing any trade.' : '查看下一份日报，取得并核对交易条件、数量与风险边界后，再决定是否授权交易。');
  return parseReportExecutionPlan({ schemaVersion: 1, parameterOrigin: 'system_observation', evidenceIds: [], gaps: [], noTradeReason: body,
    strategy: { title: en ? 'System observation plan' : '系统保留的观察计划', body, timezone,
      startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(), entries: [{ id: 'report_follow_up', text, sourceKeys: [] }] } }, new Set(), now);
}

/** Deterministic human copy text. Proposal values stay separate from observed evidence and investor authority. */
export function renderReportExecutionPlan(plan: ReportExecutionPlan, language: string): string {
  const en = language === 'en';
  const observation = plan.parameterOrigin === 'system_observation';
  const status = { ready: en ? 'Ready for review' : '可供核对', needs_info: en ? 'Needs information' : '待补信息', no_trade: en ? 'No trade proposed' : '建议不交易' }[plan.readiness];
  const chunks = [observation ? (en ? '## System observation plan' : '## 系统保留的观察计划') : en ? '## AI proposed investment strategy' : '## AI 建议投资策略',
    observation ? (en ? 'The AI proposal is unavailable. This system follow-up contains no automatic trading instructions.' : 'AI 策略暂不可用。以下是系统保留的待核查事项，不含自动交易指令。') : en ? 'All parameters and risk limits below are AI suggestions for review, not observed market facts or trading authorization.'
      : '以下交易参数与风险限制均为 AI 建议，需由您核对；不代表已发生的市场事实或交易授权。',
    `**${en ? 'Status' : '状态'}:** ${status}`,
    `**${en ? 'Validity' : '有效期'}:** ${plan.strategy.startsAt} – ${plan.strategy.endsAt} (${plan.strategy.timezone})`];
  if (plan.strategy.body.trim()) chunks.push(plan.strategy.body);
  for (const entry of plan.strategy.entries) {
    chunks.push(entry.text);
    if (entry.startsAt || entry.endsAt || entry.timezone)
      chunks.push(`${en ? 'Entry validity' : '条目有效期'}: ${entry.startsAt ?? plan.strategy.startsAt} – ${entry.endsAt ?? plan.strategy.endsAt} (${entry.timezone ?? plan.strategy.timezone})`);
    const result = plan.preview.entries.find(row => row.id === entry.id);
    if (result) chunks.push(`${en ? 'Execution explanation' : '执行说明'}: ${result.explanation[en ? 'en' : 'zh-CN']}`);
  }
  if (plan.noTradeReason) chunks.push(`**${en ? 'No-trade consideration' : '不交易考虑'}:** ${plan.noTradeReason}`);
  if (plan.strategy.limits) {
    const labels = { maxPositionPct: en ? 'Maximum total position' : '单一总仓位上限', maxDailyIncreasePct: en ? 'Maximum daily increase' : '单日增加上限',
      maxDailyTurnoverPct: en ? 'Maximum daily turnover' : '单日换手上限', minCashPct: en ? 'Minimum cash' : '最低现金比例',
      maxGrossExposurePct: en ? 'Maximum gross exposure' : '总敞口上限', maxOrderPct: en ? 'Maximum order' : '单笔上限' };
    chunks.push(`### ${en ? 'Proposed risk limits' : '建议风险限制'}\n\n${Object.entries(plan.strategy.limits)
      .map(([key, value]) => `- ${labels[key as keyof typeof labels]}: ${value}%`).join('\n')}`);
  } else if (!observation) chunks.push(en ? 'Proposed risk limits: not supplied.' : '建议风险限制：尚未提供。');
  if (!observation) chunks.push(`**${en ? 'Cited evidence' : '引用依据'}:** ${plan.evidenceIds.length ? plan.evidenceIds.join(', ') : en ? 'Not supplied' : '尚未提供'}`);
  if (plan.gaps.length) chunks.push(`### ${en ? 'Information gaps' : '待补信息'}\n\n${plan.gaps.map(gap => `- ${gap}`).join('\n')}`);
  return chunks.join('\n\n');
}
