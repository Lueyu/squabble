import type {
  BuilderConfig,
  BuilderTemplate,
  PaperSide,
  RecordBuilderFillDto,
} from '../../../shared/api.interface';
import type { CouncilConfig } from '../../../shared/council.interface';
import { normalizeCadence } from './trading-cadence';
import { parseNativeAgentConfiguration } from '../local-agents/local-agents.requests';
import { normalizeAutomation } from './strategy.rules';

export function normalizeCouncil(input?: CouncilConfig): CouncilConfig {
  if (input === undefined) return { enabled: false, members: [
    { id: 'researcher', role: 'researcher', name: 'Researcher', instructions: '', model: 'fast' },
    { id: 'challenger', role: 'challenger', name: 'Challenger', instructions: '', model: 'fast' },
    { id: 'manager', role: 'manager', name: 'Portfolio manager', instructions: '', model: 'slow' },
  ] };
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.members)
    || input.members.length < 2 || input.members.length > 6) {
    throw new Error('Council needs 2–6 members and an enabled preference');
  }
  if (input.webResearch !== undefined && typeof input.webResearch !== 'boolean') throw new Error('Invalid web research preference');
  const optionalText = (value: unknown, maximum: number): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length > maximum) throw new Error('Invalid member customization');
    return value.trim();
  };
  const ids = new Set<string>();
  const members = input.members.map((member) => {
    // Historical A2A team records become native selections and require reconnecting their provider.
    const executionMode = String(member?.executionMode ?? 'model') === 'a2a' ? 'local' : member?.executionMode;
    if (!member || !['researcher', 'challenger', 'manager'].includes(member.role)) throw new Error('Invalid council role');
    if (typeof member.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(member.id) || ids.has(member.id)) throw new Error('Invalid council member id');
    if (typeof member.name !== 'string' || !member.name.trim() || member.name.trim().length > 40) throw new Error('Member name must contain 1–40 characters');
    if (typeof member.instructions !== 'string' || member.instructions.length > 1000) throw new Error('Member instructions must be at most 1000 characters');
    if (member.model !== 'fast' && member.model !== 'slow') throw new Error('Invalid member model tier');
    if (executionMode !== undefined && !['model', 'local'].includes(executionMode)) throw new Error('Invalid member execution mode');
    if (executionMode === 'local' && (typeof member.agentId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(member.agentId))) throw new Error('Select a registered local agent');
    const agentSettings = parseNativeAgentConfiguration(member.agentSettings);
    if (agentSettings && executionMode !== 'local') throw new Error('Native agent settings require local execution');
    if (member.connectionId !== undefined && (typeof member.connectionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(member.connectionId))) {
      throw new Error('Invalid model connection identifier');
    }
    if (member.speakingStyle !== undefined && !['concise', 'detailed', 'socratic'].includes(member.speakingStyle)) throw new Error('Invalid speaking style');
    if (member.avatar !== undefined && !['value', 'growth', 'risk', 'technical', 'news', 'macro', 'moderator'].includes(member.avatar)) throw new Error('Invalid member avatar');
    if (member.researchFocus !== undefined && (!Array.isArray(member.researchFocus) || member.researchFocus.length > 5
      || member.researchFocus.some((kind) => !['financials', 'valuation', 'news', 'price', 'web'].includes(kind)))) throw new Error('Invalid research focus');
    ids.add(member.id);
    return { id: member.id, role: member.role, name: member.name.trim(), instructions: member.instructions.trim(), model: member.model,
      ...(executionMode === 'local' ? { executionMode: 'local' as const, agentId: member.agentId } : {}),
      ...(agentSettings ? { agentSettings } : {}),
      ...(member.connectionId === undefined ? {} : { connectionId: member.connectionId }),
      ...(member.avatar === undefined ? {} : { avatar: member.avatar }),
      ...(member.roleTitle === undefined ? {} : { roleTitle: optionalText(member.roleTitle, 60) }),
      ...(member.personality === undefined ? {} : { personality: optionalText(member.personality, 240) }),
      ...(member.researchFocus === undefined ? {} : { researchFocus: [...new Set(member.researchFocus)] }),
      ...(member.speakingStyle === undefined ? {} : { speakingStyle: member.speakingStyle }) };
  });
  if (members.filter((member) => member.role === 'manager').length !== 1) throw new Error('Council requires exactly one moderator');
  return { enabled: input.enabled, members, webResearch: input.webResearch ?? false };
}

/** Inputs that are known at one bot scan, before an order is considered. */
export interface BuilderSignalContext {
  ticker: string;
  source: 'holding' | 'watchlist';
  rating: string | null;
  heldShares: number;
  price: number;
  fxToUsd: number;
  equityUsd: number;
  cashUsd: number;
  targetBuy: number | null;
  targetPrice: number | null;
  marketOpen: boolean;
  quoteFresh: boolean;
  tradedToday: boolean;
}

export interface BuilderSignal {
  side: PaperSide;
  quantity: number;
  reason: string;
}

const TEMPLATES: BuilderTemplate[] = ['guard', 'scout', 'balanced'];

/** Validate executable limits and normalize the investor's allowlist. */
export function normalizeBuilderConfig(input: BuilderConfig): BuilderConfig {
  if (!input || typeof input !== 'object') throw new Error('Agent configuration is required');
  if (input.language !== undefined && input.language !== 'zh-CN' && input.language !== 'en') throw new Error('Invalid agent language');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 64) throw new Error('Agent name must contain 1–64 characters');
  if (!TEMPLATES.includes(input.template)) throw new Error('Unknown agent template');
  if (!Array.isArray(input.tickers) || input.tickers.length > 100) {
    throw new Error('Ticker list must contain at most 100 symbols');
  }
  const tickers = [...new Set(input.tickers.map((ticker) => {
    if (typeof ticker !== 'string') throw new Error('Invalid ticker');
    const normalized = ticker.trim().toUpperCase();
    if (!/^[A-Z0-9.^-]{1,20}$/.test(normalized)) throw new Error(`Invalid ticker: ${ticker}`);
    return normalized;
  }))];
  const explicitAllowlist = tickers.length > 0;
  if (input.priceRules !== undefined && (!Array.isArray(input.priceRules) || input.priceRules.length > 20)) {
    throw new Error('Price rules must be a list of at most 20 symbols');
  }
  const priceRules: NonNullable<BuilderConfig['priceRules']> = [];
  const seenRules = new Set<string>();
  for (const rule of input.priceRules ?? []) {
    if (!rule || typeof rule.ticker !== 'string') throw new Error('Invalid price rule ticker');
    const ticker = rule.ticker.trim().toUpperCase();
    if (!/^[A-Z0-9.^-]{1,20}$/.test(ticker) || seenRules.has(ticker)) {
      throw new Error(`Invalid or duplicate price rule ticker: ${rule.ticker}`);
    }
    seenRules.add(ticker);
    const buyAtOrBelow = rule.buyAtOrBelow;
    const sellAtOrAbove = rule.sellAtOrAbove;
    if (buyAtOrBelow === undefined && sellAtOrAbove === undefined) {
      throw new Error('A price rule needs a buy or sell trigger');
    }
    if (buyAtOrBelow !== undefined && (!Number.isFinite(buyAtOrBelow) || buyAtOrBelow <= 0)) {
      throw new Error('Buy price trigger must be positive');
    }
    if (sellAtOrAbove !== undefined && (!Number.isFinite(sellAtOrAbove) || sellAtOrAbove <= 0)) {
      throw new Error('Sell price trigger must be positive');
    }
    priceRules.push({ ticker, buyAtOrBelow, sellAtOrAbove });
    if (explicitAllowlist && !tickers.includes(ticker)) tickers.push(ticker);
  }
  if (tickers.length > 100) throw new Error('Ticker list must contain at most 100 symbols');
  if (input.minimumRating !== 'Buy' && input.minimumRating !== 'Strong Buy') {
    throw new Error('Unknown minimum rating');
  }
  if (typeof input.customPrompt !== 'string' || input.customPrompt.length > 2_000) {
    throw new Error('Custom instructions must be at most 2000 characters');
  }
  if (!Number.isFinite(input.maxOrderPct) || input.maxOrderPct <= 0 || input.maxOrderPct > 20) {
    throw new Error('Per-order limit must be between 0 and 20%');
  }
  if (!Number.isFinite(input.dailyLossLimitPct) || input.dailyLossLimitPct <= 0 || input.dailyLossLimitPct > 20) {
    throw new Error('Daily loss limit must be between 0 and 20%');
  }
  if (!Number.isInteger(input.maxOrdersPerDay) || input.maxOrdersPerDay < 1 || input.maxOrdersPerDay > 20) {
    throw new Error('Daily order cap must be between 1 and 20');
  }
  if (typeof input.notifyOnProposal !== 'boolean') throw new Error('Notification preference is required');
  const automation = normalizeAutomation(input.automation);
  if (automation.fastReviewer) {
    automation.fastReviewer = normalizeCouncil({ enabled: true, members: [
      { ...automation.fastReviewer, id: 'fast-reviewer', role: 'researcher', model: 'fast' },
      { id: 'validation-manager', role: 'manager', name: 'Manager', instructions: '', model: 'slow' },
    ] }).members[0];
  }
  const council = normalizeCouncil(input.council);
  if (automation.enabled && !council.enabled) throw new Error('Daily automation requires an enabled research council');
  return { ...input, name, tickers, priceRules, customPrompt: input.customPrompt.trim(), language: input.language ?? 'zh-CN',
    cadence: normalizeCadence(input.cadence), council,
    ...(input.automation === undefined ? {} : { automation }) };
}

/** A transparent, deterministic decision. The LLM may veto but never bypass it. */
export function decideBuilderSignal(
  config: BuilderConfig,
  ctx: BuilderSignalContext,
): BuilderSignal | null {
  if (!ctx.quoteFresh || !ctx.marketOpen || ctx.tradedToday || ctx.price <= 0) return null;
  if (config.tickers.length > 0 && !config.tickers.includes(ctx.ticker.toUpperCase())) return null;
  const priceRule = config.priceRules?.find((rule) => rule.ticker === ctx.ticker.toUpperCase());

  if (ctx.heldShares > 0) {
    const bearish = ctx.rating === 'Sell' || ctx.rating === 'Strong Sell';
    const reachedInvestorPrice = priceRule?.sellAtOrAbove !== undefined
      && ctx.price >= priceRule.sellAtOrAbove;
    const reachedTarget = ctx.targetPrice !== null && ctx.price >= ctx.targetPrice;
    if (bearish || reachedInvestorPrice || reachedTarget) {
      return {
        side: 'sell',
        quantity: Math.floor(ctx.heldShares),
        reason: reachedInvestorPrice
          ? `Investor price rule: ${ctx.price} reached sell trigger ${priceRule.sellAtOrAbove}`
          : bearish
          ? `AI rating ${ctx.rating}; close the paper position`
          : `Price ${ctx.price} reached the recorded target ${ctx.targetPrice}`,
      };
    }
    return null;
  }

  if (config.template === 'guard') return null;
  if (config.template === 'scout' && ctx.source !== 'watchlist') return null;
  if (ctx.rating === 'Sell' || ctx.rating === 'Strong Sell') return null;
  const bullish = ctx.rating === 'Strong Buy' || (
    config.minimumRating === 'Buy' && ctx.rating === 'Buy'
  );
  const investorBuyTriggered = priceRule?.buyAtOrBelow !== undefined
    && ctx.price <= priceRule.buyAtOrBelow;
  if (priceRule?.buyAtOrBelow !== undefined && !investorBuyTriggered) return null;
  if (!bullish && !investorBuyTriggered) return null;
  if (!investorBuyTriggered && ctx.targetBuy !== null && ctx.price > ctx.targetBuy * 1.02) return null;
  const perShareUsd = ctx.price * ctx.fxToUsd;
  if (!Number.isFinite(perShareUsd) || perShareUsd <= 0) return null;
  const notionalUsd = Math.min(
    ctx.equityUsd * config.maxOrderPct / 100,
    ctx.cashUsd * 0.9,
  );
  const quantity = Math.floor(notionalUsd / perShareUsd);
  if (quantity < 1) return null;
  return {
    side: 'buy',
    quantity,
    reason: investorBuyTriggered
      ? `Investor price rule: ${ctx.price} reached buy trigger ${priceRule.buyAtOrBelow}; limited to ${config.maxOrderPct}% of paper equity`
      : `AI rating ${ctx.rating}; limited to ${config.maxOrderPct}% of paper equity`,
  };
}

/** Validate a self-reported broker fill before it enters the comparison ledger. */
export function validateManualFill(
  input: RecordBuilderFillDto,
  now: Date = new Date(),
): RecordBuilderFillDto {
  const executedAt = new Date(input.executedAt);
  if (!Number.isFinite(executedAt.getTime()) || executedAt.getTime() > now.getTime() + 300_000) {
    throw new Error('Execution time must be a valid past time');
  }
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error('Executed quantity must be positive');
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new Error('Executed price must be positive');
  }
  if (!Number.isFinite(input.fees) || input.fees < 0) {
    throw new Error('Fees must be nonnegative');
  }
  if (input.notes !== undefined && input.notes.length > 1_000) {
    throw new Error('Notes must be at most 1000 characters');
  }
  return { ...input, executedAt: executedAt.toISOString(), notes: input.notes?.trim() };
}
