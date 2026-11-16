/**
 * agent-builder.rules.ts — agent builder 的配置校验与信号判定规则（纯函数）。
 *
 * 职责边界：
 *  - 提供 council 配置校验/规范化、builder 配置校验/规范化、
 *    从"本次扫描可见输入"推导买卖信号的确定性规则、人工成交登记的入账校验。
 *  - 无数据库访问、无副作用；所有校验失败通过抛 Error 表达（错误文案为用户可见，不可改写）。
 * 上下游：
 *  - 上游（谁调用本文件）：AgentBuilderService（保存配置、跑扫描、登记成交）、相关 spec 测试。
 *  - 下游（本文件调用谁）：trading-cadence.normalizeCadence、local-agents.parseNativeAgentConfiguration。
 * 关键约定：
 *  - decideBuilderSignal 是"透明、确定性"的决策：LLM/委员会只能否决（veto），不能绕过它下单。
 *  - 金额/数量均为 number：price、quantity、fxToUsd、equityUsd、cashUsd（美元）；quantity 最终向下取整为整数股。
 *  - tickers 全部规范化为大写并去重，priceRules 的标的会并入 tickers 白名单。
 *  - 委员会成员历史 executionMode='a2a'（A2A 团队记录）迁移为 'local'，要求重新关联 provider。
 */
import type {
  BuilderConfig,
  BuilderTemplate,
  PaperSide,
  RecordBuilderFillDto,
} from '../../../shared/api.interface';
import type { CouncilConfig } from '../../../shared/council.interface';
import { normalizeCadence } from './trading-cadence';
import { parseNativeAgentConfiguration } from '../local-agents/local-agents.requests';

/**
 * normalizeCouncil — 校验并规范化委员会配置；未传入时返回缺省三人委员会。
 *
 * 规则：成员 2–6 人、必须恰好一名 manager、成员 id/name/instructions/model/
 * executionMode/agentSettings/connectionId/speakingStyle/avatar/researchFocus 各有约束；
 * 通过后仅保留有值字段并修剪文本。
 *
 * @param input 可选的原始 CouncilConfig。
 * @returns 规范化后的 CouncilConfig（webResearch 缺省 false）。
 * @throws Error 当任何成员字段非法（错误文案保持既有英文）。
 */
export function normalizeCouncil(input?: CouncilConfig): CouncilConfig {
  // 未配置时给出缺省委员会：researcher + challenger（fast）+ manager（slow）。
  if (input === undefined)
    return {
      enabled: false,
      members: [
        {
          id: 'researcher',
          role: 'researcher',
          name: 'Researcher',
          instructions: '',
          model: 'fast',
        },
        {
          id: 'challenger',
          role: 'challenger',
          name: 'Challenger',
          instructions: '',
          model: 'fast',
        },
        {
          id: 'manager',
          role: 'manager',
          name: 'Portfolio manager',
          instructions: '',
          model: 'slow',
        },
      ],
    };
  // 基础结构校验：开关必须布尔、成员数组 2–6 人。
  if (
    !input ||
    typeof input.enabled !== 'boolean' ||
    !Array.isArray(input.members) ||
    input.members.length < 2 ||
    input.members.length > 6
  ) {
    throw new Error('Council needs 2–6 members and an enabled preference');
  }
  if (input.webResearch !== undefined && typeof input.webResearch !== 'boolean')
    throw new Error('Invalid web research preference');
  // 可选文本字段（roleTitle/personality）的统一校验与修剪。
  const optionalText = (value: unknown, maximum: number): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length > maximum)
      throw new Error('Invalid member customization');
    return value.trim();
  };
  // 逐成员校验并输出规范化后的成员对象。
  const ids = new Set<string>();
  const members = input.members.map((member) => {
    // Historical A2A team records become native selections and require reconnecting their provider.
    const executionMode =
      String(member?.executionMode ?? 'model') === 'a2a' ? 'local' : member?.executionMode;
    if (!member || !['researcher', 'challenger', 'manager'].includes(member.role))
      throw new Error('Invalid council role');
    if (
      typeof member.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(member.id) ||
      ids.has(member.id)
    )
      throw new Error('Invalid council member id');
    if (typeof member.name !== 'string' || !member.name.trim() || member.name.trim().length > 40)
      throw new Error('Member name must contain 1–40 characters');
    if (typeof member.instructions !== 'string' || member.instructions.length > 1000)
      throw new Error('Member instructions must be at most 1000 characters');
    if (member.model !== 'fast' && member.model !== 'slow')
      throw new Error('Invalid member model tier');
    if (executionMode !== undefined && !['model', 'local'].includes(executionMode))
      throw new Error('Invalid member execution mode');
    // 本地执行必须选定一个已注册的本地 agent。
    if (
      executionMode === 'local' &&
      (typeof member.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(member.agentId))
    )
      throw new Error('Select a registered local agent');
    // native agent 设置只允许在本地执行模式下出现。
    const agentSettings = parseNativeAgentConfiguration(member.agentSettings);
    if (agentSettings && executionMode !== 'local')
      throw new Error('Native agent settings require local execution');
    // connectionId 必须是 UUID v1–v8 形态。
    if (
      member.connectionId !== undefined &&
      (typeof member.connectionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          member.connectionId,
        ))
    ) {
      throw new Error('Invalid model connection identifier');
    }
    if (
      member.speakingStyle !== undefined &&
      !['concise', 'detailed', 'socratic'].includes(member.speakingStyle)
    )
      throw new Error('Invalid speaking style');
    if (
      member.avatar !== undefined &&
      !['value', 'growth', 'risk', 'technical', 'news', 'macro', 'moderator'].includes(
        member.avatar,
      )
    )
      throw new Error('Invalid member avatar');
    // researchFocus 至多 5 项，每项须属于白名单。
    if (
      member.researchFocus !== undefined &&
      (!Array.isArray(member.researchFocus) ||
        member.researchFocus.length > 5 ||
        member.researchFocus.some(
          (kind) => !['financials', 'valuation', 'news', 'price', 'web'].includes(kind),
        ))
    )
      throw new Error('Invalid research focus');
    ids.add(member.id);
    // 仅透传有值字段；文本统一 trim。
    return {
      id: member.id,
      role: member.role,
      name: member.name.trim(),
      instructions: member.instructions.trim(),
      model: member.model,
      ...(executionMode === 'local'
        ? { executionMode: 'local' as const, agentId: member.agentId }
        : {}),
      ...(agentSettings ? { agentSettings } : {}),
      ...(member.connectionId === undefined ? {} : { connectionId: member.connectionId }),
      ...(member.avatar === undefined ? {} : { avatar: member.avatar }),
      ...(member.roleTitle === undefined ? {} : { roleTitle: optionalText(member.roleTitle, 60) }),
      ...(member.personality === undefined
        ? {}
        : { personality: optionalText(member.personality, 240) }),
      ...(member.researchFocus === undefined
        ? {}
        : { researchFocus: [...new Set(member.researchFocus)] }),
      ...(member.speakingStyle === undefined ? {} : { speakingStyle: member.speakingStyle }),
    };
  });
  // 收尾约束：恰好一名 manager（moderator）。
  if (members.filter((member) => member.role === 'manager').length !== 1)
    throw new Error('Council requires exactly one moderator');
  return { enabled: input.enabled, members, webResearch: input.webResearch ?? false };
}

/** 一次 bot 扫描在"考虑是否下单之前"就已知的全部输入。 */
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

/** 信号决策结果：方向 + 数量（整数股）+ 决策理由。 */
export interface BuilderSignal {
  side: PaperSide;
  quantity: number;
  reason: string;
}

/** 可选的 agent 模板集合。 */
const TEMPLATES: BuilderTemplate[] = ['guard', 'scout', 'balanced'];

/**
 * normalizeBuilderConfig — 校验可执行限额并规范化投资者的标的白名单。
 *
 * 规则：名称 1–64 字符、模板必须已知、tickers ≤100 个（大写去重）、
 * priceRules ≤20 条且标的并入白名单、最低评级只接受 Buy/Strong Buy、
 * 自定义提示 ≤2000 字符、单笔 ≤20%、日亏损上限 ≤20%、日订单数 1–20、
 * 提案通知偏好必填；cadence 与 council 分别递归规范化。
 *
 * @param input 原始 BuilderConfig。
 * @returns 规范化后的 BuilderConfig（language 缺省 zh-CN）。
 * @throws Error 当任何字段非法（错误文案保持既有英文）。
 */
export function normalizeBuilderConfig(input: BuilderConfig): BuilderConfig {
  if (!input || typeof input !== 'object') throw new Error('Agent configuration is required');
  // 语言只接受 zh-CN / en。
  if (input.language !== undefined && input.language !== 'zh-CN' && input.language !== 'en')
    throw new Error('Invalid agent language');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 64) throw new Error('Agent name must contain 1–64 characters');
  if (!TEMPLATES.includes(input.template)) throw new Error('Unknown agent template');
  // 标的白名单：大写、去重、逐个校验字符集。
  if (!Array.isArray(input.tickers) || input.tickers.length > 100) {
    throw new Error('Ticker list must contain at most 100 symbols');
  }
  const tickers = [
    ...new Set(
      input.tickers.map((ticker) => {
        if (typeof ticker !== 'string') throw new Error('Invalid ticker');
        const normalized = ticker.trim().toUpperCase();
        if (!/^[A-Z0-9.^-]{1,20}$/.test(normalized)) throw new Error(`Invalid ticker: ${ticker}`);
        return normalized;
      }),
    ),
  ];
  const explicitAllowlist = tickers.length > 0;
  // 价格规则：至多 20 条，标的去重且并入白名单，买卖触发价必须为正数且至少给一个。
  if (
    input.priceRules !== undefined &&
    (!Array.isArray(input.priceRules) || input.priceRules.length > 20)
  ) {
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
    // 价格规则涉及的标的自动进入白名单。
    if (explicitAllowlist && !tickers.includes(ticker)) tickers.push(ticker);
  }
  // 并入价格规则后仍不得突破 100 上限。
  if (tickers.length > 100) throw new Error('Ticker list must contain at most 100 symbols');
  // 最低评级：只接受 Buy / Strong Buy。
  if (input.minimumRating !== 'Buy' && input.minimumRating !== 'Strong Buy') {
    throw new Error('Unknown minimum rating');
  }
  // 限额类校验：自定义提示、单笔比例、日亏损、日订单数。
  if (typeof input.customPrompt !== 'string' || input.customPrompt.length > 2_000) {
    throw new Error('Custom instructions must be at most 2000 characters');
  }
  if (!Number.isFinite(input.maxOrderPct) || input.maxOrderPct <= 0 || input.maxOrderPct > 20) {
    throw new Error('Per-order limit must be between 0 and 20%');
  }
  if (
    !Number.isFinite(input.dailyLossLimitPct) ||
    input.dailyLossLimitPct <= 0 ||
    input.dailyLossLimitPct > 20
  ) {
    throw new Error('Daily loss limit must be between 0 and 20%');
  }
  if (
    !Number.isInteger(input.maxOrdersPerDay) ||
    input.maxOrdersPerDay < 1 ||
    input.maxOrdersPerDay > 20
  ) {
    throw new Error('Daily order cap must be between 1 and 20');
  }
  if (typeof input.notifyOnProposal !== 'boolean')
    throw new Error('Notification preference is required');
  // 组装规范化结果：cadence / council 递归校验。
  return {
    ...input,
    name,
    tickers,
    priceRules,
    customPrompt: input.customPrompt.trim(),
    language: input.language ?? 'zh-CN',
    cadence: normalizeCadence(input.cadence),
    council: normalizeCouncil(input.council),
  };
}

/**
 * decideBuilderSignal — 透明、确定性的信号决策（LLM 只能否决，不能绕过）。
 *
 * 判定顺序：
 *  1. 前置门槛：行情新鲜、开市、今日未交易过、价格 > 0；标的须在白名单内。
 *  2. 持仓时：评级转空、触及投资者卖出触发价、或触及目标价 → 全仓卖出（向下取整）。
 *  3. 空仓时：guard 模板永不买入；scout 只买自选列表；评级须达标或投资者买入触发价命中；
 *     目标买入价超出 2% 不追；名义金额 = min(净值×单笔上限, 现金×90%)，折算股数 < 1 则不买。
 *
 * @param config 规范化后的 BuilderConfig。
 * @param ctx    本次扫描可见输入（BuilderSignalContext）。
 * @returns 信号（side/quantity/reason）；不触发时返回 null。
 */
export function decideBuilderSignal(
  config: BuilderConfig,
  ctx: BuilderSignalContext,
): BuilderSignal | null {
  // 前置门槛：任一不满足直接放弃本轮信号。
  if (!ctx.quoteFresh || !ctx.marketOpen || ctx.tradedToday || ctx.price <= 0) return null;
  if (config.tickers.length > 0 && !config.tickers.includes(ctx.ticker.toUpperCase())) return null;
  const priceRule = config.priceRules?.find((rule) => rule.ticker === ctx.ticker.toUpperCase());

  // 持仓分支：只考虑卖出。
  if (ctx.heldShares > 0) {
    const bearish = ctx.rating === 'Sell' || ctx.rating === 'Strong Sell';
    const reachedInvestorPrice =
      priceRule?.sellAtOrAbove !== undefined && ctx.price >= priceRule.sellAtOrAbove;
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

  // 空仓分支：模板与评级门槛。
  if (config.template === 'guard') return null;
  if (config.template === 'scout' && ctx.source !== 'watchlist') return null;
  if (ctx.rating === 'Sell' || ctx.rating === 'Strong Sell') return null;
  const bullish =
    ctx.rating === 'Strong Buy' || (config.minimumRating === 'Buy' && ctx.rating === 'Buy');
  // 投资者设置了买入触发价时，只有价格触及才允许买。
  const investorBuyTriggered =
    priceRule?.buyAtOrBelow !== undefined && ctx.price <= priceRule.buyAtOrBelow;
  if (priceRule?.buyAtOrBelow !== undefined && !investorBuyTriggered) return null;
  if (!bullish && !investorBuyTriggered) return null;
  // 目标买入价约束：现价超出目标价 2% 不追高。
  if (!investorBuyTriggered && ctx.targetBuy !== null && ctx.price > ctx.targetBuy * 1.02)
    return null;
  // 仓位计算：单笔名义金额 = min(净值×单笔上限, 现金×90%)，折算股数向下取整。
  const perShareUsd = ctx.price * ctx.fxToUsd;
  if (!Number.isFinite(perShareUsd) || perShareUsd <= 0) return null;
  const notionalUsd = Math.min((ctx.equityUsd * config.maxOrderPct) / 100, ctx.cashUsd * 0.9);
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

/**
 * validateManualFill — 校验用户自报的券商成交，之后才进入对照台账。
 *
 * 规则：成交时间必须是合法过去时刻（允许 5 分钟时钟偏移）、数量与价格为正、
 * 手续费非负、备注 ≤1000 字符；通过后返回规范化副本（ISO 时间、备注 trim）。
 *
 * @param input 用户提交的成交登记。
 * @param now   当前时刻（缺省 new Date()，测试可注入）。
 * @returns 规范化后的 RecordBuilderFillDto。
 * @throws Error 当任何字段非法（错误文案保持既有英文）。
 */
export function validateManualFill(
  input: RecordBuilderFillDto,
  now: Date = new Date(),
): RecordBuilderFillDto {
  // 成交时间：必须可解析且不晚于当前 5 分钟（容许时钟偏移）。
  const executedAt = new Date(input.executedAt);
  if (!Number.isFinite(executedAt.getTime()) || executedAt.getTime() > now.getTime() + 300_000) {
    throw new Error('Execution time must be a valid past time');
  }
  // 数量、价格必须为正数。
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error('Executed quantity must be positive');
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new Error('Executed price must be positive');
  }
  // 手续费非负；备注限长。
  if (!Number.isFinite(input.fees) || input.fees < 0) {
    throw new Error('Fees must be nonnegative');
  }
  if (input.notes !== undefined && input.notes.length > 1_000) {
    throw new Error('Notes must be at most 1000 characters');
  }
  return { ...input, executedAt: executedAt.toISOString(), notes: input.notes?.trim() };
}
