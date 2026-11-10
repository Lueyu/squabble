import { randomUUID } from 'node:crypto';
import type { InterviewText, StrategyInterviewAnswer, StrategyInterviewExample, StrategyInterviewField,
  StrategyInterviewQuestion, StrategyInterviewState, StrategyInterviewValue } from '../../../shared/strategy-interview.interface';
import type { StrategyDraftInput, StrategyDirective } from '../../../shared/user-investment-strategy.interface';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import { splitStrategySourceText } from '../../../shared/strategy-source-reading';
import { simulationDayStart } from './simulation-review.rules';

const text = (en: string, zh: string): InterviewText => ({ en, 'zh-CN': zh });
export const INTERVIEW_FIELDS: StrategyInterviewField[] = ['idea', 'security', 'condition', 'amount', 'frequency', 'period'];
const questions: Record<StrategyInterviewField, StrategyInterviewQuestion> = {
  idea: { field: 'idea', text: text('What would you like this strategy to do?', '你想尝试怎样的策略？'),
    help: text('An unfinished idea is enough. We will ask about one decision at a time.', '一句还没想完整的想法也可以。我们会逐轮聊清影响行动的决定。') },
  security: { field: 'security', text: text('Which exact security, and buying or selling?', '这次先看哪个证券，想买入还是卖出？'),
    help: text('Include the supported symbol and direction, for example “buy AAPL”. A company nickname is not a verified symbol.', '请说出证券代码和方向，例如“买入 AAPL”。公司简称不能替代准确代码；示例不代表推荐。') },
  condition: { field: 'condition', text: text('What price condition should trigger the action?', '价格满足什么明确条件时，才考虑行动？'),
    help: text('“price < 20” excludes 20; “price <= 20” includes it. Complex or qualitative conditions stay observations until supported.', '“价格低于20”不包含20；“不高于20”包含20。复杂或定性条件暂保留观察，不会自动简化成价格规则。') },
  amount: { field: 'amount', text: text('An exact share quantity, or a total position target after trading?', '你希望明确买卖多少股，还是交易后达到多少总仓位？'),
    help: text('“target total position 10%” includes existing holdings. “add another 10%” is not a total target. Values are your choice.', '“买完后达到总资产的10%”包括已有仓位；“每次再加10%”含义不同。数值由你决定，示例不是默认值。') },
  frequency: { field: 'frequency', text: text('Once for this version, or at most once each trading day?', '这条规则整个版本只执行一次，还是每交易日最多一次？'),
    help: text('Choose “once” or “once per trading day”. Reaching a position target still prevents additional buying.', '可以回答“只执行一次”或“每交易日最多一次”。达到目标总仓位后仍不会继续追加。') },
  period: { field: 'period', text: text('When should this rule be valid?', '你希望这条规则在哪段时间内有效？'),
    help: text('Give a date range such as “2026-11-10 to 2026-12-10”, or an explicit duration such as “next 30 days”. Account timezone applies.', '可以回答“2026-11-10 到 2026-12-10”或“未来30天”。使用账户时区，起止日期会在采纳前展示；示例不是默认期限。') },
};

/** This deliberately narrow parser proposes values only. It never turns free text into confirmed authority. */
export function parseInterviewAnswer(field: StrategyInterviewField, raw: string, now: Date, timezone = 'Asia/Shanghai', securitySide?: 'buy' | 'sell'): StrategyInterviewValue | null {
  const value = raw.trim().replace(/[。.!！]$/u, '').trim();
  if (!value) return null;
  if (field === 'idea') return { kind: 'idea', text: raw };
  if (/不确定|没想好|也许|大概|可能|或者|或许|maybe|unsure|not sure|approximately|\bor\b/iu.test(value)) return null;
  if (field === 'security') {
    const match = /^(买入|买|卖出|卖|buy|sell)\s*([A-Za-z0-9.^-]+)$/iu.exec(value)
      ?? /^([A-Za-z0-9.^-]+)\s+(买入|买|卖出|卖|buy|sell)$/iu.exec(value);
    if (!match) return null;
    const parts = match.slice(1);
    const action = parts.find(part => /^(买入|买|卖出|卖|buy|sell)$/iu.test(part))!;
    const ticker = resolveTradingTicker(parts.find(part => part !== action)!.toUpperCase());
    return ticker ? { kind: 'security', ticker: ticker.ticker, side: /^(买|买入|buy)$/iu.test(action) ? 'buy' : 'sell' } : null;
  }
  if (field === 'condition') {
    const match = /^(?:有效价格|价格|price)?\s*(严格低于|低于|小于等于|小于|不高于|严格高于|高于|大于等于|大于|不低于|below|under|less than|at most|above|greater than|at least|<=|>=|<|>)\s*[¥￥$]?\s*(\d+(?:\.\d+)?)\s*(?:元)?$/iu.exec(value);
    if (!match || !Number.isFinite(Number(match[2])) || Number(match[2]) <= 0) return null;
    const operators: Record<string, StrategyDirective['trigger']['kind']> = {
      '<': 'price_lt', '低于': 'price_lt', '小于': 'price_lt', '严格低于': 'price_lt',
      '<=': 'price_lte', '不高于': 'price_lte', '小于等于': 'price_lte',
      '>': 'price_gt', '高于': 'price_gt', '大于': 'price_gt', '严格高于': 'price_gt',
      '>=': 'price_gte', '不低于': 'price_gte', '大于等于': 'price_gte',
      below: 'price_lt', under: 'price_lt', 'less than': 'price_lt', 'at most': 'price_lte',
      above: 'price_gt', 'greater than': 'price_gt', 'at least': 'price_gte',
    };
    return { kind: 'condition', trigger: { kind: operators[match[1].toLowerCase()], price: Number(match[2]) } };
  }
  if (field === 'amount') {
    const quantity = /^(?:(买入|买|卖出|卖|buy|sell)\s*)?(\d+)\s*(?:股|shares)$/iu.exec(value);
    if (quantity) {
      const side = quantity[1] ? /^(买|买入|buy)$/iu.test(quantity[1]) ? 'buy' : 'sell' : undefined;
      if (side && securitySide && side !== securitySide) return null;
      return Number.isSafeInteger(Number(quantity[2])) && Number(quantity[2]) > 0 ? { kind: 'amount', quantity: Number(quantity[2]) } : null;
    }
    const target = /^(?:买完后达到总资产的|交易后达到总资产的|买到总资产的|补至总资产的|目标总仓位|总仓位目标|target total position)\s*(\d+(?:\.\d+)?)\s*%(?:[，,]\s*不是每次再加\s*(\d+(?:\.\d+)?)\s*%)?$/iu.exec(value);
    if (target && securitySide === 'sell' && /^(?:买完后|买到|补至)/u.test(value)) return null;
    return target && Number(target[1]) > 0 && Number(target[1]) <= 100 && (!target[2] || Number(target[2]) === Number(target[1]))
      ? { kind: 'amount', positionPct: Number(target[1]) } : null;
  }
  if (field === 'frequency') {
    if (/^(只执行一次|整个版本只执行一次|一次|once)$/iu.test(value)) return { kind: 'frequency', frequency: 'once' };
    if (/^(?:(?:本条规则)?每交易日最多(?:执行)?一次|每个交易日一次|once per trading day)$/iu.test(value)) return { kind: 'frequency', frequency: 'per_trading_day' };
    return null;
  }
  const duration = /^(?:未来|从现在起|next)\s*(\d+)\s*(?:天|days)$/iu.exec(value);
  if (duration && Number(duration[1]) > 0 && Number(duration[1]) <= 366) {
    return { kind: 'period', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + Number(duration[1]) * 86400000).toISOString(), timezone };
  }
  const range = /^(?:从\s*)?(\d{4}-\d{2}-\d{2})\s*(?:到|至|to)\s*(\d{4}-\d{2}-\d{2})$/iu.exec(value);
  if (!range) return null;
  try {
    const start = simulationDayStart(range[1], timezone);
    const last = new Date(`${range[2]}T00:00:00Z`);
    if (!Number.isFinite(last.getTime()) || last.toISOString().slice(0, 10) !== range[2]) return null;
    last.setUTCDate(last.getUTCDate() + 1);
    const end = simulationDayStart(last.toISOString().slice(0, 10), timezone);
    if (end <= start || end.getTime() - start.getTime() > 366 * 86400000 || end <= now) return null;
    return { kind: 'period', startsAt: start.toISOString(), endsAt: end.toISOString(), timezone };
  } catch { return null; }
}

function project(state: StrategyInterviewState): StrategyInterviewState {
  state.pending = INTERVIEW_FIELDS.filter(field => !state.confirmed.some(answer => answer.field === field)).map(field => questions[field]);
  state.currentQuestion = state.pending[0] ?? null;
  return state;
}
export function initialInterviewState(message: string, now: Date): StrategyInterviewState {
  return answerInterview({ messages: [], confirmed: [], suggestions: [], pending: [], currentQuestion: questions.idea, review: null }, 'idea', message, now);
}
export function answerInterview(original: StrategyInterviewState, field: StrategyInterviewField, message: string, now: Date, timezone?: string): StrategyInterviewState {
  const state = structuredClone(original);
  if (state.messages.length >= 120) throw new Error('INTERVIEW_MESSAGE_LIMIT');
  const previous = state.confirmed.find(answer => answer.field === field)?.sourceMessageId
    ?? [...state.messages].reverse().find(item => item.role === 'user' && item.field === field)?.id;
  // A changed premise invalidates dependent choices; their original messages remain readable.
  const affected: StrategyInterviewField[] = field === 'idea' ? INTERVIEW_FIELDS
    : field === 'security' ? ['security', 'condition', 'amount'] : [field];
  state.confirmed = state.confirmed.filter(answer => !affected.includes(answer.field));
  state.suggestions = [];
  state.review = null;
  const id = randomUUID();
  state.messages.push({ id, role: 'user', field, text: message, createdAt: now.toISOString(), ...(previous ? { supersedesMessageId: previous } : {}) });
  const parsed = parseInterviewAnswer(field, message, now, timezone, valueOf(state.confirmed, 'security')?.side);
  if (parsed) state.suggestions.push({ id: randomUUID(), field, value: parsed, quote: message, sourceMessageId: id,
    explanation: text('This is a proposed reading of your exact answer. Confirm it or change your answer; it is not yet a trading rule.', '这是对你原话的待采纳整理。请核对后采纳，或修改回答；它还不是执行规则。') });
  const localizedText = parsed ? text('Saved. Review the proposed reading before continuing.', '已保存原话。请核对待采纳的整理，再继续下一问。')
    : text(`${questions[field].text.en} ${questions[field].help.en}`, `${questions[field].text['zh-CN']} ${questions[field].help['zh-CN']}`);
  state.messages.push({ id: randomUUID(), role: 'assistant', field, createdAt: now.toISOString(),
    localizedText,
    text: parsed ? '已保存原话。请核对待采纳的整理，再继续下一问。 / Saved. Review the proposed reading before continuing.'
      : `${questions[field].text['zh-CN']} ${questions[field].help['zh-CN']}\n${questions[field].text.en} ${questions[field].help.en}` });
  return project(state);
}
export function acceptInterviewSuggestion(original: StrategyInterviewState, suggestionId: string, now: Date): StrategyInterviewState {
  const state = structuredClone(original);
  const suggestion = state.suggestions.find(item => item.id === suggestionId);
  if (!suggestion || !state.pending.some(question => question.field === suggestion.field)) throw new Error('INTERVIEW_SUGGESTION_CHANGED');
  const source = [...state.messages].reverse().find(message => message.role === 'user' && message.field === suggestion.field);
  if (source?.id !== suggestion.sourceMessageId || source.text !== suggestion.quote) throw new Error('INTERVIEW_SUGGESTION_CHANGED');
  if (suggestion.field === 'amount' && !amountMatchesSecurity(suggestion.value, suggestion.quote, valueOf(state.confirmed, 'security')?.side, now)) {
    throw new Error('INTERVIEW_SUGGESTION_CHANGED');
  }
  state.confirmed = state.confirmed.filter(answer => answer.field !== suggestion.field);
  state.confirmed.push({ field: suggestion.field, value: suggestion.value, quote: suggestion.quote,
    sourceMessageId: suggestion.sourceMessageId, confirmedAt: now.toISOString() });
  state.suggestions = [];
  state.review = null;
  return project(state);
}

function valueOf<K extends StrategyInterviewValue['kind']>(answers: StrategyInterviewAnswer[], kind: K): Extract<StrategyInterviewValue, { kind: K }> | undefined {
  return answers.find(answer => answer.value.kind === kind)?.value as Extract<StrategyInterviewValue, { kind: K }> | undefined;
}
/** Recheck saved interpretations too: an older suggestion must not hide a conflicting action. */
function amountMatchesSecurity(value: StrategyInterviewValue, quote: string, side: 'buy' | 'sell' | undefined, now: Date): boolean {
  const parsed = parseInterviewAnswer('amount', quote, now, undefined, side);
  return Boolean(side && value.kind === 'amount' && parsed?.kind === 'amount'
    && value.quantity === parsed.quantity && value.positionPct === parsed.positionPct);
}
/** Compile only explicitly accepted values; preserve the interview transcript with the hashed strategy content. */
export function interviewDraft(state: StrategyInterviewState, limits: Record<string, number>, observationOnly: boolean, now: Date): StrategyDraftInput {
  if (!observationOnly && INTERVIEW_FIELDS.some(field => !state.confirmed.some(item => item.field === field))) throw new Error('INTERVIEW_INCOMPLETE');
  const idea = valueOf(state.confirmed, 'idea');
  const security = valueOf(state.confirmed, 'security');
  const condition = valueOf(state.confirmed, 'condition');
  const amount = valueOf(state.confirmed, 'amount');
  const frequency = valueOf(state.confirmed, 'frequency');
  const period = valueOf(state.confirmed, 'period');
  const amountAnswer = state.confirmed.find(answer => answer.field === 'amount');
  if (!observationOnly && (!amountAnswer || !amountMatchesSecurity(amountAnswer.value, amountAnswer.quote, security?.side, now))) {
    throw new Error('INTERVIEW_ANSWER_CONFLICT');
  }
  const transcript = state.messages.filter(item => item.role === 'user')
    .map(item => `[${item.field}; message=${item.id}${item.supersedesMessageId ? `; replaces=${item.supersedesMessageId}` : ''}] ${item.text}`).join('\n');
  const confirmations = state.confirmed.map(item => `${item.field}: message=${item.sourceMessageId}; confirmed=${item.confirmedAt}`).join('\n');
  const confirmedText = state.confirmed.map(item => item.quote).join('\n');
  const entryText = observationOnly ? transcript : `${security!.ticker}\n${confirmedText}`;
  const draft: StrategyDraftInput = {
    title: (idea?.text ?? state.messages[0]?.text ?? 'Observation / 观察').slice(0, 120),
    body: `${observationOnly ? 'Observation only; no trading authorization. / 仅观察，未授权交易。\n' : ''}${transcript}\n\nConfirmed answers / 已确认回答\n${confirmations}`,
    timezone: period?.timezone ?? 'UTC', startsAt: period?.startsAt ?? now.toISOString(),
    // Required storage envelope for an observation has no execution effect.
    endsAt: period?.endsAt ?? new Date(now.getTime() + 86400000).toISOString(),
    entries: (observationOnly ? splitStrategySourceText(entryText) : [entryText]).map((part, index) => ({ id: index ? `interview_observation_${index}` : 'interview_rule', text: part,
      sourceKeys: [], ...(security ? { ticker: security.ticker } : {}) })),
  };
  if (!observationOnly) {
    const required = ['maxPositionPct', 'maxDailyIncreasePct', 'maxDailyTurnoverPct'];
    if (required.some(key => !Number.isFinite(limits[key]))) throw new Error('INTERVIEW_ACCOUNT_LIMITS_REQUIRED');
    draft.limits = { maxPositionPct: limits.maxPositionPct, maxDailyIncreasePct: limits.maxDailyIncreasePct,
      maxDailyTurnoverPct: limits.maxDailyTurnoverPct, minCashPct: limits.minCashPct,
      maxGrossExposurePct: limits.maxGrossExposurePct, maxOrderPct: limits.maxOrderPct };
    const evidence = state.confirmed.flatMap(answer => {
      const numericQuote = (number: number) => (answer.quote.match(/\d+(?:\.\d+)?/gu) ?? []).find(token => Number(token) === number) ?? '';
      if (answer.value.kind === 'condition' && answer.value.trigger.price !== undefined) return [{ field: 'trigger.price', value: answer.value.trigger.price, quote: numericQuote(answer.value.trigger.price) }];
      if (answer.value.kind === 'amount') return [{ field: answer.value.quantity !== undefined ? 'quantity' : 'positionPct',
        value: answer.value.quantity ?? answer.value.positionPct!, quote: numericQuote(answer.value.quantity ?? answer.value.positionPct!) }];
      return [];
    });
    draft.entries[0].directive = { ticker: security!.ticker, side: security!.side, trigger: condition!.trigger,
      quantity: amount!.quantity, positionPct: amount!.positionPct,
      executionFrequency: frequency!.frequency === 'once' ? { kind: 'once' } : { kind: 'per_trading_day', maxExecutions: 1 },
      reviewedText: entryText, numericEvidence: evidence };
  }
  return draft;
}

export function interviewExamples(draft: StrategyDraftInput): StrategyInterviewExample[] {
  const directive = draft.entries[0]?.directive;
  if (!directive) return [{ id: 'observation', scenario: text('Any market price', '任何行情价格'), outcome: 'no_action',
    explanation: text('This draft contains observations only and cannot create an order.', '这份草稿只有观察内容，不能生成委托。') }];
  const strict = directive.trigger.kind === 'price_lt' || directive.trigger.kind === 'price_gt';
  const examples: StrategyInterviewExample[] = [
    { id: 'matched', scenario: text('The reviewed price condition is met, the target is not reached, and valid cash/risk checks allow the amount', '价格满足已核对条件、目标尚未达到，且有效现金与风险检查允许确认数量'), outcome: 'plan',
      explanation: text('A candidate plan may be proposed; a plan is not a fill and final execution checks still apply.', '可以提出候选计划；计划不等于成交，最终仍需复核执行条件。') },
    { id: 'threshold', scenario: text(`Price equals ${directive.trigger.price}`, `价格恰好等于 ${directive.trigger.price}`), outcome: strict ? 'no_action' : 'plan',
      explanation: strict ? text('The strict comparison excludes equality.', '严格比较不包含等于阈值。')
        : text('The price condition includes equality; all other execution checks still apply.', '价格条件包含等于阈值；仍需通过其他执行检查。') },
    { id: 'stale', scenario: text('The quote is stale or unavailable', '行情已过期或不可用'), outcome: 'wait',
      explanation: text('A valid price is required before a plan can execute.', '必须有有效行情才能执行计划。') },
    { id: 'budget', scenario: text('Cash or strategy allocation cannot cover the approved amount', '现金或策略预算不足以覆盖确认数量'), outcome: 'wait',
      explanation: text('Execution waits and records the limiting constraint; the approved amount is not invented.', '等待并记录限制原因，不擅自编造确认数量。') },
    { id: 'repeat', scenario: text('This entry has already executed in its allowed period', '本条规则在允许周期内已经执行'), outcome: 'no_action',
      explanation: directive.executionFrequency?.kind === 'per_trading_day' ? text('Wait for a later verified trading day.', '等待下一个经校验的交易日再检查。')
        : text('This confirmed entry executes only once.', '这条已确认规则只执行一次。') },
  ];
  if (directive.positionPct !== undefined) examples.push({ id: 'target', scenario: text(`Existing position is at the ${directive.positionPct}% target`, `已有仓位达到 ${directive.positionPct}% 目标`), outcome: 'no_action',
    explanation: text('A total target includes existing holdings; it is not an incremental order percentage.', '目标总仓位包括已有持仓，不是每次新增该比例。') });
  return examples;
}
