import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import type { StrategyDraftInput, StrategySourceSnapshot, StrategyExecutionPreview, StrategyValidationIssue,
  StrategyDirective, StrategySourceAddition, StrategyEntry } from '../../../shared/user-investment-strategy.interface';
import { validateStrategyRules } from './strategy.rules';
import { splitStrategySourceText } from '../../../shared/strategy-source-reading';

const positive = z.number().finite().positive();
const timestamp = z.string().datetime({ offset: true });
const timezone = z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
const directiveSchema = z.object({ ticker: z.string().min(1).max(30), side: z.enum(['buy', 'sell']),
  trigger: z.object({ kind: z.enum(['price_lt', 'price_lte', 'price_gt', 'price_gte', 'always', 'semantic']), price: positive.optional(), text: z.string().max(1000).optional() }).strict(),
  executionFrequency: z.discriminatedUnion('kind', [z.object({ kind: z.literal('once') }).strict(),
    z.object({ kind: z.literal('per_trading_day'), maxExecutions: z.literal(1) }).strict()]).optional(),
  quantity: positive.optional(), positionPct: positive.max(100).optional(), minPrice: positive.optional(), maxPrice: positive.optional(), stopLossPrice: positive.optional(),
  semanticAuthorized: z.boolean().optional(), reviewedText: z.string().max(12000),
  numericEvidence: z.array(z.object({ field: z.string().max(40), value: positive, quote: z.string().min(1).max(120) }).strict()).max(10),
}).strict();
const limitsSchema = z.object({ maxPositionPct: positive.max(100), maxDailyIncreasePct: positive.max(100), maxDailyTurnoverPct: positive.max(200),
  minCashPct: z.number().finite().min(0).max(100).optional(), maxGrossExposurePct: positive.max(100).optional(), maxOrderPct: positive.max(100).optional() }).strict();
const entrySchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), text: z.string().min(1).max(12000), ticker: z.string().max(30).optional(),
  sourceKeys: z.array(z.string().min(1).max(200)).max(20), startsAt: timestamp.optional(), endsAt: timestamp.optional(), timezone: timezone.optional(),
  directive: directiveSchema.optional(), mandateRule: z.custom<NonNullable<StrategyEntry['mandateRule']>>().optional(), mandateReviewedText: z.string().max(12000).optional() }).strict();
const draftSchema = z.object({ title: z.string().trim().min(1).max(120), body: z.string().max(40000), timezone,
  startsAt: timestamp, endsAt: timestamp, entries: z.array(entrySchema).max(20), limits: limitsSchema.optional() }).strict();

export function normalizeStrategyDraft(input: unknown): StrategyDraftInput {
  const draft = draftSchema.parse(input);
  const start = Date.parse(draft.startsAt); const end = Date.parse(draft.endsAt);
  if (end <= start || end - start > 366 * 86400000) throw new Error('Invalid strategy period');
  if (new Set(draft.entries.map(entry => entry.id)).size !== draft.entries.length) throw new Error('Duplicate strategy entry');
  for (const entry of draft.entries) {
    const entryStart = Date.parse(entry.startsAt ?? draft.startsAt); const entryEnd = Date.parse(entry.endsAt ?? draft.endsAt);
    if (entryStart < start || entryEnd > end || entryStart >= entryEnd) throw new Error('Entry period must fit the total strategy');
    if (entry.directive) entry.directive.ticker = resolveTradingTicker(entry.directive.ticker)?.ticker ?? entry.directive.ticker;
  }
  return draft;
}
export const strategyContentHash = (content: StrategyDraftInput, sources: StrategySourceSnapshot[]) => createHash('sha256').update(JSON.stringify({ content, sources })).digest('hex');
const message = (en: string, zh: string) => ({ en, 'zh-CN': zh });
const numericFields = (directive: StrategyDirective): Array<[string, number | undefined]> => [
  ['trigger.price', directive.trigger.price], ['quantity', directive.quantity], ['positionPct', directive.positionPct],
  ['minPrice', directive.minPrice], ['maxPrice', directive.maxPrice], ['stopLossPrice', directive.stopLossPrice],
];
/** Numeric tokens are checked only as evidence; no trading condition is guessed from regular expressions. */
function supportedNumber(directive: StrategyDirective, field: string, value: number, text: string) {
  return directive.numericEvidence.some(proof => proof.field === field && proof.value === value && text.includes(proof.quote)
    && (proof.quote.match(/(?:\d+(?:\.\d+)?)/g) ?? []).some(token => Number(token) === value));
}
export function previewStrategy(content: StrategyDraftInput, sources: StrategySourceSnapshot[], revision: number, now = new Date()): StrategyExecutionPreview {
  const preview: StrategyExecutionPreview = { revision, contentHash: strategyContentHash(content, sources), generatedAt: now.toISOString(), canConfirm: true,
    entries: [], directives: [], mandateRules: [], issues: [] };
  const issue = (code: string, ids: string[], en: string, zh: string, severity: StrategyValidationIssue['severity'] = 'error') => {
    preview.issues.push({ code, entryIds: ids, severity, message: message(en, zh) });
  };
  for (const entry of content.entries) {
    const startsAt = entry.startsAt ?? content.startsAt; const endsAt = entry.endsAt ?? content.endsAt; const zone = entry.timezone ?? content.timezone;
    const result: StrategyExecutionPreview['entries'][number] = { id: entry.id, ticker: entry.directive?.ticker ?? entry.ticker ?? null,
      state: 'observation', startsAt, endsAt, timezone: zone,
      explanation: message('Observation only. Add a security, condition and explicit quantity or position limit before execution.', '仅作为观察事项。执行前请明确证券、条件和股数或仓位范围。') };
    preview.entries.push(result);
    if (Date.parse(endsAt) <= now.getTime()) { result.state = 'expired'; result.explanation = message('Expired: stop creating candidates; no forced sale.', '已到期：停止生成新候选，不会自动清仓。'); continue; }
    if (entry.sourceKeys.some(key => !sources.some(source => source.key === key))) { issue('SOURCE_MISSING', [entry.id], 'A pinned source is missing.', '缺少固定来源。'); continue; }
    const directive = entry.directive;
    const unreviewedPlan = sources.find(source => entry.sourceKeys.includes(source.key)
      && source.executionPlan?.readiness === 'needs_info' && source.executionPlan.strategy.entries.some(proposed => proposed.text === entry.text));
    if (unreviewedPlan) {
      result.state = 'needs_review';
      issue('REPORT_PLAN_NEEDS_INFO', [entry.id], 'This report proposal has unresolved gaps. Edit and review the entry before applying.',
        '此报告提案仍有信息缺口，请编辑并核对条目后再应用。');
      continue;
    }
    if (!directive) {
      if (entry.mandateRule) {
        if (entry.mandateReviewedText !== entry.text) {
          result.state = 'needs_review'; issue('TEXT_CHANGED', [entry.id], 'Review the measurable rule against the exact entry text.', '请按当前条目正文重新核对明确执行规则。'); continue;
        }
        try {
          if (!content.limits) throw new Error('Global execution limits are required');
          const rule = validateStrategyRules([entry.mandateRule], { tickers: [entry.mandateRule.ticker],
            evidenceIds: sources.flatMap(source => source.versionId ? [source.versionId] : []), expiresAt: new Date(endsAt), now, maxPositionPct: content.limits.maxPositionPct })[0];
          preview.mandateRules.push({ ...rule, semanticCondition: entry.mandateRule.semanticCondition, reviewMode: entry.mandateRule.reviewMode });
          result.state = 'executable'; result.explanation = message(`${rule.side} ${rule.ticker}; ${rule.trigger.kind} ${rule.trigger.value}; position ≤ ${rule.maxPositionPct}%; execution price ${rule.minPrice}–${rule.maxPrice}; stop ${rule.stopLossPrice}; ends ${rule.expiresAt} (${zone}).`,
            `${rule.ticker}：${rule.side === 'buy' ? '买入' : '卖出'}；条件 ${rule.trigger.kind} ${rule.trigger.value}；仓位不超过 ${rule.maxPositionPct}%；价格 ${rule.minPrice}–${rule.maxPrice}；止损 ${rule.stopLossPrice}；至 ${rule.expiresAt}（${zone}）。`);
        } catch { issue('INVALID_MANDATE_RULE', [entry.id], 'The measurable rule or its report evidence is invalid.', '明确规则或报告依据未通过校验。'); }
      }
      continue;
    }
    result.state = 'needs_review';
    if (directive.reviewedText !== entry.text) { issue('TEXT_CHANGED', [entry.id], 'The entry changed after its explanation was prepared. Preview it again.', '正文已改动，请重新整理执行说明。'); continue; }
    const namedSymbols = (entry.text.match(/[A-Za-z0-9^.-]+/gu) ?? []).map(symbol => resolveTradingTicker(symbol)?.ticker);
    if (!resolveTradingTicker(directive.ticker) || !(namedSymbols.includes(directive.ticker) || entry.sourceKeys.some(key => sources.some(source => source.key === key && source.ticker && resolveTradingTicker(source.ticker)?.ticker === directive.ticker)))) {
      issue('SECURITY_UNVERIFIED', [entry.id], 'Confirm the exact supported security symbol.', '请确认准确且支持的证券代码。'); continue;
    }
    if (!content.limits) { issue('LIMITS_REQUIRED', [entry.id], 'Confirm the overall risk limits before applying.', '应用前请确认总体风险限制。'); continue; }
    if (numericFields(directive).some(([field, value]) => value !== undefined && !supportedNumber(directive, field, value, entry.text))) {
      issue('UNSUPPORTED_NUMBER', [entry.id], 'A number is not supported by the exact entry text. Correct the text or preview.', '有数值无法在原条目中核对，请修改正文或执行说明。'); continue;
    }
    if ((directive.quantity === undefined) === (directive.positionPct === undefined)) {
      issue('AMOUNT_REQUIRED', [entry.id], 'Specify either a share quantity or a position percentage.', '请明确股数或仓位比例其中一项。', 'warning'); continue;
    }
    if (directive.trigger.kind.startsWith('price_') && directive.trigger.price === undefined) {
      issue('CONDITION_REQUIRED', [entry.id], 'A price condition needs its explicit threshold.', '价格条件需要明确价格。', 'warning'); continue;
    }
    if (directive.trigger.kind === 'semantic' && (!directive.semanticAuthorized || !directive.trigger.text?.trim() || !entry.text.includes(directive.trigger.text))) {
      issue('SEMANTIC_AUTHORIZATION_REQUIRED', [entry.id], 'Authorize AI review of the exact qualitative condition before execution.', '执行前需明确授权 AI 研判这段语义条件。', 'warning'); continue;
    }
    if (directive.positionPct !== undefined && (directive.positionPct > content.limits.maxPositionPct || directive.side === 'buy' && directive.positionPct > (content.limits.maxGrossExposurePct ?? 100))) {
      issue('EXPOSURE_LIMIT', [entry.id], 'The entry exceeds the overall exposure limit.', '条目超过总体仓位额度。'); continue;
    }
    if (directive.minPrice !== undefined && directive.maxPrice !== undefined && directive.minPrice > directive.maxPrice) {
      issue('PRICE_BOUNDS', [entry.id], 'The minimum price exceeds the maximum price.', '最低价高于最高价。'); continue;
    }
    const amountEn = directive.quantity !== undefined ? `${directive.quantity} shares` : `target TOTAL position after this action: ${directive.positionPct}% (rounded toward the target by market lots)`;
    const amountZh = directive.quantity !== undefined ? `${directive.quantity} 股` : `交易后目标总仓位 ${directive.positionPct}%（按市场每手向目标取整）`;
    const operators = { price_lt: ['<', '严格低于'], price_lte: ['≤', '不高于'], price_gt: ['>', '严格高于'], price_gte: ['≥', '不低于'] };
    const operator = operators[directive.trigger.kind as keyof typeof operators];
    const conditionEn = directive.trigger.kind === 'always' ? 'when valid execution quotes are available' : directive.trigger.kind === 'semantic' ? `after AI confirms “${directive.trigger.text}”` : `when price ${operator[0]} ${directive.trigger.price}`;
    const conditionZh = directive.trigger.kind === 'always' ? '取得有效执行报价时' : directive.trigger.kind === 'semantic' ? `由 AI 确认「${directive.trigger.text}」后` : `价格${operator[1]} ${directive.trigger.price} 时`;
    const daily = directive.executionFrequency?.kind === 'per_trading_day';
    result.state = 'executable'; result.explanation = message(`${directive.side === 'buy' ? 'Buy' : 'Sell'} ${directive.ticker}: ${amountEn}, ${conditionEn}. ${daily ? 'At most once per verified trading day' : 'Once for this confirmed entry'}. ${startsAt} – ${endsAt} (${zone}); global risk checks still apply.`,
      `${directive.ticker}：${conditionZh}${directive.side === 'buy' ? '买入' : '卖出'} ${amountZh}。${daily ? '每个经校验的交易日最多执行一次' : '本条已确认规则只执行一次'}。${startsAt} 至 ${endsAt}（${zone}），仍须通过总体风险校验。`);
    preview.directives.push({ ...directive, entryId: entry.id, startsAt, endsAt, timezone: zone, sourceKeys: [...entry.sourceKeys], route: directive.trigger.kind === 'semantic' ? 'ai' : 'direct' });
  }
  for (let i = 0; i < preview.directives.length; i++) for (const other of preview.directives.slice(i + 1)) {
    const rule = preview.directives[i];
    if (rule.ticker === other.ticker && rule.side !== other.side && Date.parse(rule.startsAt) < Date.parse(other.endsAt) && Date.parse(other.startsAt) < Date.parse(rule.endsAt)) {
      issue('OPPOSITE_ACTIONS', [rule.entryId, other.entryId], 'Overlapping buy and sell instructions need review.', '同一证券的买卖期限重叠，请先核对。');
    }
  }
  if (content.limits && (content.limits.minCashPct ?? 0) + (content.limits.maxGrossExposurePct ?? 100) > 100) {
    issue('CASH_EXPOSURE_CONFLICT', [], 'Minimum cash and maximum exposure limits conflict.', '最低现金比例与最高总仓位存在冲突。');
  }
  if (!content.entries.length && sources.some(source => source.executionPlan?.readiness === 'needs_info'
    && !source.executionPlan.strategy.entries.length && source.executionPlan.strategy.body === content.body)) {
    issue('REPORT_PLAN_NEEDS_INFO', [], 'This report proposal is incomplete. Edit and review it before applying.',
      '此报告提案尚不完整，请编辑并核对后再应用。');
  }
  preview.canConfirm = !preview.issues.some(entry => entry.severity === 'error');
  return preview;
}
export function sourceAddition(content: StrategyDraftInput, sources: StrategySourceSnapshot[], source: StrategySourceSnapshot): StrategySourceAddition {
  if (sources.some(existing => existing.key === source.key)) return { source, entries: [], alreadyAdded: true };
  if (source.kind === 'report' && source.sectionId === 'execution-strategy' && source.executionPlan) {
    const strategy = source.executionPlan.strategy;
    const entries: StrategyEntry[] = strategy.entries.length ? strategy.entries
      : source.executionPlan.readiness === 'no_trade' && source.executionPlan.noTradeReason
        ? [{ id: 'no_trade', text: `AI 建议 / AI proposal: ${source.executionPlan.noTradeReason}`, sourceKeys: [] }] : [];
    return { source, alreadyAdded: false, entries: entries.map((entry, index) => ({
      ...structuredClone(entry), id: `source_${createHash('sha256').update(source.key).digest('hex').slice(0, 20)}_${index}`,
      sourceKeys: [source.key], startsAt: entry.startsAt ?? strategy.startsAt, endsAt: entry.endsAt ?? strategy.endsAt,
      timezone: entry.timezone ?? strategy.timezone,
      directive: source.executionPlan!.readiness === 'ready' && entry.directive ? { ...structuredClone(entry.directive), semanticAuthorized: false } : undefined,
      mandateRule: source.executionPlan!.readiness === 'ready' ? structuredClone(entry.mandateRule) : undefined,
    })) };
  }
  const parts = splitStrategySourceText(source.readableContent ?? source.content);
  const identity = `source_${createHash('sha256').update(source.key).digest('hex').slice(0, 20)}`;
  return { source, alreadyAdded: false, entries: parts.map((text, index) => ({ id: parts.length === 1 ? identity : `${identity}_${index}`,
    text, ...(source.ticker ? { ticker: source.ticker } : {}), sourceKeys: [source.key] })) };
}
