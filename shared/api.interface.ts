/**
 * api.interface.ts — server 与 client 共用的 API DTO 契约中枢。
 *
 * 职责边界：
 *  - 定义全部跨进程传输的数据形状：领域枚举、核心实体、仪表盘汇总、写入 DTO、
 *    行情/现金/全量状态、多智能体流水线、账户与认证、AI 模拟盘、新手建仓代理、
 *    集成设置、通知渠道、持仓导入、MCP 代理会话与大盘行情；仅类型，无运行时逻辑。
 *  - server（NestJS）与 client（React）两侧都从这里 import 同一份定义，
 *    任何一侧不得复制定义（避免双份漂移）。
 * 上下游：
 *  - 上游（谁 import 这份契约）：全仓 114 个文件 import 本契约（server 侧 67 个、
 *    client/src 侧 47 个），是 shared/ 中被引用最多的契约。
 *  - 下游（本文件引用了谁）：import('./council.interface')（BuilderConfig 的 council /
 *    cadence 字段以类型位置引用 CouncilConfig 与 TradingCadence）。
 * 关键约定：
 *  - 金额/价格/股数字段在数据库中以 numeric 类型存储、以字符串传输（见各实体字段），
 *    避免浮点精度问题；客户端不得对它们做隐式 number 化。
 *  - 日期时间字段均为 ISO 字符串；百分比字段（returnPct / dailyPct / weight 等）
 *    同样是字符串数值。
 *  - 分节（按文件出现顺序）：领域枚举 → 核心实体 → 仪表盘/汇总 → 写入 DTO →
 *    现金/汇率/行情/全量状态 → 多智能体流水线 → 账户与认证 → AI 模拟盘 →
 *    新手建仓代理 → 集成设置 → 通知渠道 → 持仓导入 → MCP 代理会话 → 大盘行情。
 */

// ══════════ 领域枚举 ══════════
/** 人工/系统评级五档：强烈买入 → 强烈卖出。 */
export type Rating = 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell';
/** 建议动作（中文词汇域）：加仓 / 买入 / 持有 / 减仓 / 卖出 / 观望。 */
export type Action = '加仓' | '买入' | '持有' | '减仓' | '卖出' | '观望';
/** 信号四档：强烈买入 / 买入 / 观望 / 回避。 */
export type Signal = '强烈买入' | '买入' | '观望' | '回避';
/** 市场：美股 / 港股 / A 股。 */
export type Market = 'US' | 'HK' | 'CN';
/** 币种：美元 / 港币 / 人民币。 */
export type Currency = 'USD' | 'HKD' | 'CNY';
/** 交易流水类型：买入 / 卖出 / 入金 / 出金 / 建仓。 */
export type TxType = 'Buy' | 'Sell' | 'Deposit' | 'Withdrawal' | 'Opening';

// ══════════ 核心实体（分组 / 持仓 / 观察 / 分析 / 流水 / 平仓 / 日志 / 快照 / AlphaPick） ══════════

/** 持仓分组：仅展示用途的标签组（颜色 + 排序），由用户在设置里维护。 */
export interface Group {
  /** 分组 id。 */
  id: string;
  /** 分组名。 */
  name: string;
  /** 展示颜色；未设置为 null。 */
  color: string | null;
  /** 排序值。 */
  sort: number;
}

/** 持仓：账户当前持有的标的（账户域最核心的实体）。 */
export interface Holding {
  /** 持仓 id。 */
  id: string;
  /** 标的代码（用户输入形态，如 AAPL / 0700.HK）。 */
  ticker: string;
  /** 公司名；未抓取到为 null。 */
  company: string | null;
  /** 所属行业；未抓取到为 null。 */
  sector: string | null;
  /** 买入日期；未知为 null。 */
  buyDate: string | null;
  /** 买入价（字符串数值）；未知为 null。 */
  buyPrice: string | null;
  /** 持有股数（字符串数值）。 */
  shares: string;
  /** 最新价（字符串数值）；未抓取为 null。 */
  currentPrice: string | null;
  /** 评级；未评为 null。 */
  rating: string | null;
  /** 建议动作；未评为 null。 */
  action: string | null;
  /** 分析结论文本；无则 null。 */
  analysis: string | null;
  /** 目标价（字符串数值）；无则 null。 */
  targetPrice: string | null;
  /** 所属分组 id；未分组为 null。 */
  groupId: string | null;
  /** 所属市场（由服务端从代码拼写推断）。 */
  market: Market;
  /** 计价币种。 */
  currency: Currency;
  /** 原生市场代码（如港股补零后的 "00700"）；无则 null。 */
  symbolNative: string | null;
  /** 展示用代码（通常即用户输入的 ticker）；无则 null。 */
  displaySymbol: string | null;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 观察项：自选列表里的候选标的，尚未建仓。 */
export interface WatchItem {
  /** 观察项 id。 */
  id: string;
  /** 标的代码。 */
  ticker: string;
  /** 公司名；未抓取到为 null。 */
  company: string | null;
  /** 所属行业；未抓取到为 null。 */
  sector: string | null;
  /** 加入日期；未知为 null。 */
  dateAdded: string | null;
  /** 期望买入价（字符串数值）；未设置为 null。 */
  entryPrice: string | null;
  /** 最新价（字符串数值）；未抓取为 null。 */
  currentPrice: string | null;
  /** 评级；未评为 null。 */
  rating: string | null;
  /** 信号；未评为 null。 */
  signal: string | null;
  /** 目标买入价（字符串数值）；未设置为 null。 */
  targetBuy: string | null;
  /** 分析结论文本；无则 null。 */
  analysis: string | null;
  /** 所属市场。 */
  market: Market;
  /** 计价币种。 */
  currency: Currency;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 分析记录：一次对某标的的分析结论（历史留档，与持仓解耦）。 */
export interface Analysis {
  /** 记录 id。 */
  id: string;
  /** 分析日期。 */
  analysisDate: string;
  /** 标的代码。 */
  ticker: string;
  /** 评级；无则 null。 */
  rating: string | null;
  /** 建议动作；无则 null。 */
  action: string | null;
  /** 分析正文；无则 null。 */
  analysis: string | null;
  /** 目标价（字符串数值）；无则 null。 */
  targetPrice: string | null;
  /** 催化剂；无则 null。 */
  catalysts: string | null;
  /** 风险点；无则 null。 */
  risks: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 交易流水：买入/卖出/出入金等台账记录，是持仓与现金核算的原始凭证。 */
export interface Transaction {
  /** 流水 id。 */
  id: string;
  /** 交易日期。 */
  txDate: string;
  /** 标的代码。 */
  ticker: string;
  /** 流水类型（见 TxType）。 */
  txType: TxType;
  /** 股数（字符串数值）。 */
  shares: string;
  /** 成交价（字符串数值）。 */
  price: string;
  /** 费用（字符串数值）。 */
  fees: string;
  /** 备注；无则 null。 */
  notes: string | null;
  /** 计价币种。 */
  currency: Currency;
}

/** 已平仓头寸：卖出后归档的盈亏记录（已实现盈亏的来源）。 */
export interface ClosedPosition {
  /** 记录 id。 */
  id: string;
  /** 标的代码。 */
  ticker: string;
  /** 公司名；未知为 null。 */
  company: string | null;
  /** 开仓日期；未知为 null。 */
  openDate: string | null;
  /** 平仓日期；未知为 null。 */
  closeDate: string | null;
  /** 买入价（字符串数值）；未知为 null。 */
  buyPrice: string | null;
  /** 卖出价（字符串数值）；未知为 null。 */
  sellPrice: string | null;
  /** 股数（字符串数值）；未知为 null。 */
  shares: string | null;
  /** 已实现盈亏（字符串数值）；未知为 null。 */
  realizedPl: string | null;
  /** 收益率（百分比字符串数值）；未知为 null。 */
  returnPct: string | null;
  /** 备注；无则 null。 */
  notes: string | null;
}

/** 交易日志：按日的市场/组合复盘、计划与教训（投资者手记）。 */
export interface JournalEntry {
  /** 日志 id。 */
  id: string;
  /** 日志日期。 */
  journalDate: string;
  /** 市场小结；无则 null。 */
  marketSummary: string | null;
  /** 组合小结；无则 null。 */
  portfolioSummary: string | null;
  /** 当日操作；无则 null。 */
  actions: string | null;
  /** 后续计划；无则 null。 */
  plan: string | null;
  /** 教训；无则 null。 */
  lessons: string | null;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 账户快照：某一天的账户级汇总数值（净值曲线的数据点）。 */
export interface Snapshot {
  /** 快照 id。 */
  id: string;
  /** 快照日期。 */
  snapshotDate: string;
  /** 账户总值（字符串数值）；未知为 null。 */
  accountValue: string | null;
  /** 总市值（字符串数值）；未知为 null。 */
  totalMv: string | null;
  /** 总成本（字符串数值）；未知为 null。 */
  cost: string | null;
  /** 现金（字符串数值）；未知为 null。 */
  cash: string | null;
  /** 总盈亏（字符串数值）；未知为 null。 */
  totalPl: string | null;
  /** 当日盈亏（字符串数值）；未知为 null。 */
  dailyPl: string | null;
  /** 当日盈亏百分比（字符串数值）；未知为 null。 */
  dailyPct: string | null;
  /** 当日净入金（字符串数值）；未知为 null。 */
  netDeposit: string | null;
  /** 累计净入金（字符串数值）；未知为 null。 */
  cumulativeNetDeposit: string | null;
}

/** Alpha 精选：精选池里的标的及其表现（收益率/权重/评级）。 */
export interface AlphaPick {
  /** 记录 id。 */
  id: string;
  /** 标的代码。 */
  ticker: string;
  /** 公司名；未知为 null。 */
  company: string | null;
  /** 所属行业；未知为 null。 */
  sector: string | null;
  /** 精选日期；未知为 null。 */
  datePicked: string | null;
  /** 收益率（百分比字符串数值）；未知为 null。 */
  returnPct: string | null;
  /** 评级；未知为 null。 */
  rating: string | null;
  /** 建议权重（百分比字符串数值）；未知为 null。 */
  weightPct: string | null;
}

/** 列表信封：列表接口的统一返回形状。 */
export interface ListResponse<T> {
  /** 数据条目。 */
  items: T[];
}

// ══════════ 仪表盘 / 分组汇总 ══════════

/** 分组汇总：按持仓分组聚合的市值/成本/盈亏（仪表盘分组卡片）。 */
export interface GroupSummary {
  /** 分组 id；未分组的聚合行为 null。 */
  groupId: string | null;
  /** 分组名；同上为 null。 */
  groupName: string | null;
  /** 分组颜色；同上为 null。 */
  groupColor: string | null;
  /** 组内持仓数。 */
  count: number;
  /** 组内市值（字符串数值）。 */
  marketValue: string;
  /** 组内成本（字符串数值）。 */
  cost: string;
  /** 组内盈亏（字符串数值）。 */
  pl: string;
  /** 组内收益率（百分比字符串数值）。 */
  returnPct: string;
  /** 占组合权重（百分比字符串数值）。 */
  weight: string;
}

/** 仪表盘总览：账户级聚合数值 + 分币种拆分 + 分组汇总。 */
export interface DashboardOverview {
  /** 账户总值（字符串数值）。 */
  accountValue: string;
  /** 总市值（字符串数值）。 */
  totalMv: string;
  /** 总成本（字符串数值）。 */
  cost: string;
  /** 现金（字符串数值）。 */
  cash: string;
  /** 总盈亏（字符串数值）。 */
  totalPl: string;
  /** 总盈亏百分比（字符串数值）。 */
  totalPct: string;
  /** 基准币种（汇总口径）。 */
  baseCurrency: Currency;
  /** 按币种拆分的市值（键为币种代码）。 */
  totalMvByCurrency: Record<string, string>;
  /** 按币种拆分的现金（键为币种代码）。 */
  cashByCurrency: Record<string, string>;
  /** 当日盈亏（字符串数值）。 */
  dailyPl: string;
  /** 当日盈亏百分比（字符串数值）。 */
  dailyPct: string;
  /** 分组汇总列表。 */
  groups: GroupSummary[];
}

// ══════════ 写入 DTO（各实体的 Create / Update 请求体） ══════════
// 说明：实体读取形态中的字符串数值字段，在写入 DTO 里通常是 number（由服务端落库时转换）。

/** 新建持仓请求体。 */
export interface CreateHoldingDto {
  /** 标的代码（必填，服务端据此推断市场/币种）。 */
  ticker: string;
  /** 公司名。 */
  company?: string;
  /** 所属行业。 */
  sector?: string;
  /** 买入日期。 */
  buyDate?: string;
  /** 买入价。 */
  buyPrice?: number;
  /** 股数（必填）。 */
  shares: number;
  /** 当前价。 */
  currentPrice?: number;
  /** 评级。 */
  rating?: string;
  /** 建议动作。 */
  action?: string;
  /** 分析正文。 */
  analysis?: string;
  /** 目标价。 */
  targetPrice?: number;
  /** 所属分组 id。 */
  groupId?: string;
}

/** 更新持仓请求体（部分更新；ticker/market/currency 之外的实体字段都可改，
 *  另允许修正 market / currency / 原生与展示代码）。 */
export interface UpdateHoldingDto {
  /** 公司名。 */
  company?: string;
  /** 所属行业。 */
  sector?: string;
  /** 买入日期。 */
  buyDate?: string;
  /** 买入价。 */
  buyPrice?: number;
  /** 股数。 */
  shares?: number;
  /** 当前价。 */
  currentPrice?: number;
  /** 评级。 */
  rating?: string;
  /** 建议动作。 */
  action?: string;
  /** 分析正文。 */
  analysis?: string;
  /** 目标价。 */
  targetPrice?: number;
  /** 所属分组 id。 */
  groupId?: string;
  /** 所属市场。 */
  market?: Market;
  /** 计价币种。 */
  currency?: Currency;
  /** 原生市场代码；传 null 清空。 */
  symbolNative?: string | null;
  /** 展示用代码；传 null 清空。 */
  displaySymbol?: string | null;
}

/** 新建观察项请求体。 */
export interface CreateWatchItemDto {
  /** 标的代码（必填）。 */
  ticker: string;
  /** 公司名。 */
  company?: string;
  /** 所属行业。 */
  sector?: string;
  /** 加入日期。 */
  dateAdded?: string;
  /** 期望买入价。 */
  entryPrice?: number;
  /** 当前价。 */
  currentPrice?: number;
  /** 评级。 */
  rating?: string;
  /** 信号。 */
  signal?: string;
  /** 目标买入价。 */
  targetBuy?: number;
  /** 分析正文。 */
  analysis?: string;
}

/** 更新观察项请求体（部分更新）。 */
export interface UpdateWatchItemDto {
  /** 公司名。 */
  company?: string;
  /** 所属行业。 */
  sector?: string;
  /** 期望买入价。 */
  entryPrice?: number;
  /** 当前价。 */
  currentPrice?: number;
  /** 评级。 */
  rating?: string;
  /** 信号。 */
  signal?: string;
  /** 目标买入价。 */
  targetBuy?: number;
  /** 分析正文。 */
  analysis?: string;
}

/** 新建分组请求体。 */
export interface CreateGroupDto {
  /** 分组名（必填）。 */
  name: string;
  /** 展示颜色。 */
  color?: string;
  /** 排序值。 */
  sort?: number;
}

/** 更新分组请求体（部分更新）。 */
export interface UpdateGroupDto {
  /** 分组名。 */
  name?: string;
  /** 展示颜色。 */
  color?: string;
  /** 排序值。 */
  sort?: number;
}

/** 新建分析记录请求体。 */
export interface CreateAnalysisDto {
  /** 分析日期（必填）。 */
  analysisDate: string;
  /** 标的代码（必填）。 */
  ticker: string;
  /** 评级。 */
  rating?: string;
  /** 建议动作。 */
  action?: string;
  /** 分析正文。 */
  analysis?: string;
  /** 目标价。 */
  targetPrice?: number;
  /** 催化剂。 */
  catalysts?: string;
  /** 风险点。 */
  risks?: string;
}

/** 新建交易流水请求体。 */
export interface CreateTransactionDto {
  /** 交易日期（必填）。 */
  txDate: string;
  /** 标的代码（必填）。 */
  ticker: string;
  /** 流水类型（必填）。 */
  txType: TxType;
  /** 股数（必填）。 */
  shares: number;
  /** 成交价（必填）。 */
  price: number;
  /** 费用。 */
  fees?: number;
  /** 备注。 */
  notes?: string;
  /** 币种；省略时由服务端推断。 */
  currency?: string;
}

/** 手工补录已平仓头寸请求体。 */
export interface CreateClosedDto {
  /** 标的代码（必填）。 */
  ticker: string;
  /** 公司名。 */
  company?: string;
  /** 开仓日期。 */
  openDate?: string;
  /** 平仓日期。 */
  closeDate?: string;
  /** 买入价。 */
  buyPrice?: number;
  /** 卖出价。 */
  sellPrice?: number;
  /** 股数。 */
  shares?: number;
  /** 已实现盈亏。 */
  realizedPl?: number;
  /** 收益率（%）。 */
  returnPct?: number;
  /** 备注。 */
  notes?: string;
}

/** 新建/更新交易日志请求体（按 journalDate 定位）。 */
export interface CreateJournalDto {
  /** 日志日期（必填）。 */
  journalDate: string;
  /** 市场小结。 */
  marketSummary?: string;
  /** 组合小结。 */
  portfolioSummary?: string;
  /** 当日操作。 */
  actions?: string;
  /** 后续计划。 */
  plan?: string;
  /** 教训。 */
  lessons?: string;
}

/** 新建/更新账户快照请求体（按 snapshotDate 定位）。 */
export interface CreateSnapshotDto {
  /** 快照日期（必填）。 */
  snapshotDate: string;
  /** 账户总值。 */
  accountValue?: number;
  /** 总市值。 */
  totalMv?: number;
  /** 总成本。 */
  cost?: number;
  /** 现金。 */
  cash?: number;
  /** 总盈亏。 */
  totalPl?: number;
  /** 当日盈亏。 */
  dailyPl?: number;
  /** 当日盈亏百分比（%）。 */
  dailyPct?: number;
  /** 当日净入金。 */
  netDeposit?: number;
  /** 累计净入金。 */
  cumulativeNetDeposit?: number;
}

/** 新建 Alpha 精选请求体。 */
export interface CreateAlphaPickDto {
  /** 标的代码（必填）。 */
  ticker: string;
  /** 公司名。 */
  company?: string;
  /** 所属行业。 */
  sector?: string;
  /** 精选日期。 */
  datePicked?: string;
  /** 收益率（%）。 */
  returnPct?: number;
  /** 评级。 */
  rating?: string;
  /** 建议权重（%）。 */
  weightPct?: number;
}

/** 批量价格刷新的单条输入（行情服务批量写回持仓现价）。 */
export interface BatchPriceUpdateDto {
  /** 标的代码。 */
  ticker: string;
  /** 最新价。 */
  price: number;
}

// ══════════ 现金账户 / 汇率 / 行情 / 全量状态 ══════════

/** 现金账户：按币种记账的现金余额。 */
export interface CashAccount {
  /** 账户 id。 */
  id: string;
  /** 币种。 */
  currency: Currency;
  /** 余额（字符串数值）。 */
  balance: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 汇率：某日期 base→quote 的汇率值。 */
export interface FxRate {
  /** 汇率日期。 */
  date: string;
  /** 基准币种。 */
  base: Currency;
  /** 目标币种。 */
  quote: Currency;
  /** 汇率值（1 base = rate quote，字符串数值）。 */
  rate: string;
}

/** 实时行情：单个标的的报价快照（价格/涨跌幅/OHLC/成交量）。 */
export interface QuoteResponse {
  /** 标的代码。 */
  symbol: string;
  /** 公司名称。 */
  companyName?: string;
  /** 最新价（字符串数值）。 */
  price: string;
  /** 涨跌额（字符串数值）。 */
  change: string;
  /** 涨跌幅（百分比字符串数值）。 */
  changePercent: string;
  /** 开盘价（字符串数值）。 */
  open?: string;
  /** 最高价（字符串数值）。 */
  high?: string;
  /** 最低价（字符串数值）。 */
  low?: string;
  /** 成交量（字符串数值）。 */
  volume?: string;
  /** 计价币种。 */
  currency: Currency;
  /** 所属市场。 */
  market: Market;
  /** 报价时间戳（Unix 毫秒）。 */
  timestamp: number;
  /** 行情是否为延迟数据。 */
  delayed?: boolean;
}

/** 股票搜索结果：内部（持仓/自选）与外部数据源合并后的候选项。 */
export interface StockSearchResult {
  /** 标的代码。 */
  symbol: string;
  /** 公司名称。 */
  companyName: string;
  /** 所属市场。 */
  market: Market;
  /** 计价币种。 */
  currency: Currency;
  /** 命中来源：持仓 / 自选 / 外部数据源。 */
  source: 'holding' | 'watchlist' | 'external';
}

/** 全量状态快照：账户域所有实体的一次性下发（客户端初始同步/全量刷新）。 */
export interface AgentStateResponse {
  /** 持仓列表。 */
  holdings: Holding[];
  /** 自选列表。 */
  watchlist: WatchItem[];
  /** 分组列表。 */
  groups: Group[];
  /** 分析记录列表。 */
  analysis: Analysis[];
  /** 交易流水列表。 */
  transactions: Transaction[];
  /** 已平仓列表。 */
  closed: ClosedPosition[];
  /** 交易日志列表。 */
  journal: JournalEntry[];
  /** 账户快照列表。 */
  snapshots: Snapshot[];
  /** Alpha 精选列表。 */
  alphaPicks: AlphaPick[];
  /** 现金总额（字符串数值）。 */
  cash: string;
  /** 分币种现金账户列表。 */
  cashAccounts: CashAccount[];
}

/** 对账结果：流水重放后的计数核对（数据一致性自检）。 */
export interface ReconcileResult {
  /** 重放后的持仓数。 */
  holdingsCount: number;
  /** 已平仓记录数。 */
  closedCount: number;
  /** 已处理的流水数。 */
  processedTxCount: number;
}

// ══════════ 多智能体流水线域（AgentRun / 证据 / 辩论 / 评级 / 风控 / 深度研报 / 批量运行） ══════════

// ─────────── 流水线词汇类型 ───────────

/** 运行状态机：pending → fetching → debating → critiquing → risk_check →
 *  awaiting_human（等人工）→ completed；failed / cancelled 为终态。 */
export type AgentRunStatus =
  | 'pending'
  | 'fetching'
  | 'debating'
  | 'critiquing'
  | 'risk_check'
  | 'awaiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 触发方式：定时任务 / 手动 / 自选列表命中。 */
export type AgentRunTrigger = 'cron' | 'manual' | 'watchlist';

/** 运行档位：full=完整流水线；summary=轻量摘要。批量模式下高确信标的全量、其余摘要。 */
export type AgentRunMode = 'full' | 'summary';
/** 分析输出语言。 */
export type AnalysisLanguage = 'zh-CN' | 'en';

/** 智能体评级：在 Rating 五档基础上多一档 Watch（观察）。 */
export type AgentRating = 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell' | 'Watch';

/** 置信度三档。 */
export type AgentConfidence = 'high' | 'medium' | 'low';

/** 证据角色：基本面 / 新闻 / 技术面 / 宏观。 */
export type EvidenceRole = 'fundamental' | 'news' | 'technical' | 'macro';

/** 证据类型：财报 / 新闻 / 价格 / 指标 / 评级 / 其他。 */
export type EvidenceType = 'financial' | 'news' | 'price' | 'indicator' | 'rating' | 'other';

/** 辩论立场：多 / 空。 */
export type DebateSide = 'bull' | 'bear';

/** 辩论发言者：多方 / 空方 / 批评者 / 主持人。 */
export type DebateSpeaker = 'bull' | 'bear' | 'critic' | 'moderator';

/** 规则性质：hard=硬性（可一票否决）；soft=软性（提示）。 */
export type RuleType = 'hard' | 'soft';

/** 规则类别：仓位集中 / 止盈止损 / 买入条件 / 现金管理 / 风控闸门。 */
export type RuleCategory =
  | 'position_concentration'
  | 'stop_loss_take_profit'
  | 'buy_conditions'
  | 'cash_management'
  | 'risk_gate';

/** 规则严重级：warning=仅告警；hard_block=硬性拦截。 */
export type RuleSeverity = 'warning' | 'hard_block';

/** 人工决策四态：批准 / 修改后批准 / 拒绝 / 待定。 */
export type HumanDecision = 'approved' | 'modified' | 'rejected' | 'pending';

/** 审计动作：运行开始/完成/失败，人工批准/修改/拒绝，评级落账。 */
export type AuditAction =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'human_approved'
  | 'human_modified'
  | 'human_rejected'
  | 'rating_applied';

// ─────────── 运行与证据实体 ───────────

/** 一次多智能体运行的主体记录（状态、目标价、人工决策等）。 */
export interface AgentRun {
  /** 运行 id。 */
  id: string;
  /** 标的代码。 */
  ticker: string;
  /** 标的名称；未知为 null。 */
  tickerName: string | null;
  /** 市场；未知为 null。 */
  market: string | null;
  /** 触发方式。 */
  triggerType: AgentRunTrigger;
  /** 运行档位。 */
  runMode: AgentRunMode;
  /** 分析输出语言。 */
  language: AnalysisLanguage;
  /** 运行状态。 */
  status: AgentRunStatus;
  /** 本次实际使用的快通道模型名；未定为 null。 */
  modelFast: string | null;
  /** 本次实际使用的慢通道模型名；未定为 null。 */
  modelSlow: string | null;
  /** 已消耗 token 数。 */
  tokensUsed: number;
  /** 成本估算（字符串数值）。 */
  costEstimate: string;
  /** 开始时间（ISO 字符串）；未开始为 null。 */
  startedAt: string | null;
  /** 完成时间（ISO 字符串）；未完成为 null。 */
  completedAt: string | null;
  /** 失败信息；无则 null。 */
  errorMessage: string | null;
  /** 人工决策；未决为 null。 */
  humanDecision: HumanDecision | null;
  /** 人工备注；无则 null。 */
  humanNote: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
  /** 悲观目标价（字符串数值）；无则 null。 */
  targetBear: string | null;
  /** 基准目标价（字符串数值）；无则 null。 */
  targetBase: string | null;
  /** 乐观目标价（字符串数值）；无则 null。 */
  targetBull: string | null;
  /** 置信度；无则 null。 */
  confidence: AgentConfidence | null;
}

/** 证据：流水线各阶段引用的外部素材（带来源与抓取时间）。 */
export interface AgentEvidence {
  /** 证据 id。 */
  id: string;
  /** 所属运行 id。 */
  runId: string;
  /** 证据角色。 */
  role: EvidenceRole;
  /** 证据类型。 */
  evidenceType: EvidenceType;
  /** 标题。 */
  title: string;
  /** 内容。 */
  content: string;
  /** 来源 URL；无则 null。 */
  sourceUrl: string | null;
  /** 来源名称；无则 null。 */
  sourceName: string | null;
  /** 抓取时间（ISO 字符串）。 */
  fetchedAt: string;
  /** 相关性得分（字符串数值）；未评分为 null。 */
  relevanceScore: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 多空论点：辩论中一方的主张，可引用证据、可被对方驳斥。 */
export interface BullBearArgument {
  /** 论点 id。 */
  id: string;
  /** 所属运行 id。 */
  runId: string;
  /** 立场。 */
  side: DebateSide;
  /** 辩论轮次。 */
  round: number;
  /** 论点正文。 */
  argument: string;
  /** 引用的证据 id 列表。 */
  evidenceIds: string[];
  /** 驳斥该论点的对方论点 id；未被驳斥为 null。 */
  counteredBy: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 辩论发言记录：辩论/批评阶段的一条发言（含 token 消耗）。 */
export interface DebateRecord {
  /** 记录 id。 */
  id: string;
  /** 所属运行 id。 */
  runId: string;
  /** 轮次。 */
  round: number;
  /** 发言者角色。 */
  speaker: DebateSpeaker;
  /** 发言正文。 */
  content: string;
  /** 该发言消耗的 token 数。 */
  tokensUsed: number;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 评级记录：流水线汇总出的最终评级与目标价（落持仓前的候选评级）。 */
export interface AgentRatingRecord {
  /** 记录 id。 */
  id: string;
  /** 所属运行 id。 */
  runId: string;
  /** 标的代码。 */
  ticker: string;
  /** 评级。 */
  rating: AgentRating;
  /** 置信度。 */
  confidence: AgentConfidence;
  /** 目标价（字符串数值）；无则 null。 */
  targetPrice: string | null;
  /** 建议动作文本。 */
  action: string;
  /** 评级聚合逻辑说明；无则 null。 */
  aggregationLogic: string | null;
  /** 关键不确定性；无则 null。 */
  keyUncertainty: string | null;
  /** 多方小结；无则 null。 */
  bullSummary: string | null;
  /** 空方小结；无则 null。 */
  bearSummary: string | null;
  /** 催化剂；无则 null。 */
  catalysts: string | null;
  /** 风险点；无则 null。 */
  risks: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 风控闸门单条结果：某条规则在本运行的通过情况。 */
export interface RiskGateResult {
  /** 结果 id。 */
  id: string;
  /** 所属运行 id。 */
  runId: string;
  /** 规则名。 */
  ruleName: string;
  /** 规则性质。 */
  ruleType: RuleType;
  /** 是否通过。 */
  passed: boolean;
  /** 当前值（字符串数值）；无则 null。 */
  currentValue: string | null;
  /** 阈值（字符串数值）；无则 null。 */
  thresholdValue: string | null;
  /** 细节说明；无则 null。 */
  detail: string | null;
  /** 建议动作；无则 null。 */
  suggestedAction: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 策略规则：风控/买入条件等可配置规则的持久化定义。 */
export interface StrategyRule {
  /** 规则 id。 */
  id: string;
  /** 规则键（程序内的稳定标识）。 */
  ruleKey: string;
  /** 规则名（展示）。 */
  ruleName: string;
  /** 规则性质。 */
  ruleType: RuleType;
  /** 阈值（字符串数值）；无则 null。 */
  threshold: string | null;
  /** 阈值单位；无则 null。 */
  unit: string | null;
  /** 是否启用。 */
  enabled: boolean;
  /** 规则描述；无则 null。 */
  description: string | null;
  /** 规则类别；无则 null。 */
  category: RuleCategory | null;
  /** 严重级。 */
  severity: RuleSeverity;
  /** 排序值。 */
  sort: number;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 审计日志：运行与人工决策的关键动作留痕。 */
export interface AgentAuditLog {
  /** 日志 id。 */
  id: string;
  /** 关联运行 id；与运行无关的动作为 null。 */
  runId: string | null;
  /** 审计动作。 */
  action: AuditAction;
  /** 动作细节（自由 JSON）；无则 null。 */
  detail: Record<string, unknown> | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

// ─────────── 运行详情与流水线写入 DTO ───────────

/** 运行详情：AgentRun 主体 + 证据/论点/发言/评级/风控结果全量装配（详情页一次拉取）。 */
export interface AgentRunDetail extends AgentRun {
  /** 证据列表。 */
  evidence: AgentEvidence[];
  /** 多空论点列表。 */
  arguments: BullBearArgument[];
  /** 辩论发言列表。 */
  debate: DebateRecord[];
  /** 最终评级；未产出为 null。 */
  rating: AgentRatingRecord | null;
  /** 风控闸门结果列表。 */
  riskGate: RiskGateResult[];
}

/** 创建运行请求：触发方式必填，其余沿用默认（档位默认 summary、语言默认 zh-CN）。 */
export interface CreateAgentRunDto {
  /** 标的代码。 */
  ticker: string;
  /** 标的名称；缺省由服务端补。 */
  tickerName?: string;
  /** 市场；缺省由服务端推断。 */
  market?: string;
  /** 触发方式。 */
  triggerType: AgentRunTrigger;
  /** 运行档位。 */
  runMode?: AgentRunMode;
  /** 分析输出语言。 */
  language?: AnalysisLanguage;
}

/** 更新运行请求：仅允许改状态与人工决策字段。 */
export interface UpdateAgentRunDto {
  /** 新状态。 */
  status?: AgentRunStatus;
  /** 人工决策。 */
  humanDecision?: HumanDecision;
  /** 人工备注。 */
  humanNote?: string;
}

/** 写入证据请求：runId 由路径参数提供，不在 body 中。 */
export interface CreateEvidenceDto {
  /** 证据角色。 */
  role: EvidenceRole;
  /** 证据类型。 */
  evidenceType: EvidenceType;
  /** 标题。 */
  title: string;
  /** 内容。 */
  content: string;
  /** 来源 URL。 */
  sourceUrl?: string;
  /** 来源名称。 */
  sourceName?: string;
  /** 抓取时间（ISO 字符串）。 */
  fetchedAt: string;
  /** 相关性得分；写入 DTO 用 number，读取时为字符串数值。 */
  relevanceScore?: number;
}

/** 写入多空论点请求。 */
export interface CreateArgumentDto {
  /** 立场。 */
  side: DebateSide;
  /** 辩论轮次。 */
  round?: number;
  /** 论点正文。 */
  argument: string;
  /** 引用的证据 id 列表。 */
  evidenceIds?: string[];
  /** 驳斥该论点的对方论点 id。 */
  counteredBy?: string;
}

/** 写入辩论发言请求。 */
export interface CreateDebateRecordDto {
  /** 轮次。 */
  round: number;
  /** 发言者角色。 */
  speaker: DebateSpeaker;
  /** 发言正文。 */
  content: string;
  /** 该发言消耗的 token 数。 */
  tokensUsed?: number;
}

/** 写入评级请求：runId 由路径参数提供。 */
export interface CreateAgentRatingDto {
  /** 标的代码。 */
  ticker: string;
  /** 评级。 */
  rating: AgentRating;
  /** 置信度。 */
  confidence: AgentConfidence;
  /** 目标价；写入 DTO 用 number。 */
  targetPrice?: number;
  /** 建议动作文本。 */
  action: string;
  /** 评级聚合逻辑说明。 */
  aggregationLogic?: string;
  /** 关键不确定性。 */
  keyUncertainty?: string;
  /** 多方小结。 */
  bullSummary?: string;
  /** 空方小结。 */
  bearSummary?: string;
  /** 催化剂。 */
  catalysts?: string;
  /** 风险点。 */
  risks?: string;
}

/** 写入风控闸门结果请求。 */
export interface CreateRiskGateDto {
  /** 规则名。 */
  ruleName: string;
  /** 规则性质。 */
  ruleType: RuleType;
  /** 是否通过。 */
  passed: boolean;
  /** 当前值；写入 DTO 用 number。 */
  currentValue?: number;
  /** 阈值；写入 DTO 用 number。 */
  thresholdValue?: number;
  /** 细节说明。 */
  detail?: string;
  /** 建议动作。 */
  suggestedAction?: string;
}

/** 更新策略规则请求：全部字段可选，ruleKey 不可改。 */
export interface UpdateStrategyRuleDto {
  /** 规则名（展示）。 */
  ruleName?: string;
  /** 规则性质。 */
  ruleType?: RuleType;
  /** 阈值；写入 DTO 用 number。 */
  threshold?: number;
  /** 阈值单位。 */
  unit?: string;
  /** 是否启用。 */
  enabled?: boolean;
  /** 规则描述。 */
  description?: string;
  /** 规则类别。 */
  category?: RuleCategory;
  /** 严重级。 */
  severity?: RuleSeverity;
  /** 排序值。 */
  sort?: number;
}

/** 创建策略规则请求：ruleKey 为程序内稳定标识，创建后不可改。 */
export interface CreateStrategyRuleDto {
  /** 规则键。 */
  ruleKey: string;
  /** 规则名（展示）。 */
  ruleName: string;
  /** 规则性质。 */
  ruleType: RuleType;
  /** 阈值；写入 DTO 用 number。 */
  threshold?: number;
  /** 阈值单位。 */
  unit?: string;
  /** 规则描述。 */
  description?: string;
  /** 规则类别。 */
  category?: RuleCategory;
  /** 严重级。 */
  severity?: RuleSeverity;
  /** 排序值。 */
  sort?: number;
}

/** 策略规则重排序请求：单条提交 id + 新排序值。 */
export interface ReorderStrategyRuleDto {
  /** 规则 id。 */
  id: string;
  /** 新排序值。 */
  sort: number;
}

/** 流水线过程追踪：记录一次分析各阶段（证据/辩论/批评/风控/评级）的执行状态与摘要。 */
export interface AnalysisTrace {
  /** 分析输出语言。 */
  language: AnalysisLanguage;
  /** 执行引擎：basic=规则/模板流程，llm=大模型流水线。 */
  engine: 'basic' | 'llm';
  /** 实际使用的提供商名；无则 null。 */
  provider: string | null;
  /** 实际使用的模型名；无则 null。 */
  model: string | null;
  /** 生成时间（ISO 字符串）。 */
  generatedAt: string;
  /** 各阶段执行记录。 */
  steps: Array<{
    /** 阶段 id。 */
    id: 'evidence' | 'debate' | 'critique' | 'risk' | 'rating';
    /** 执行状态：completed=完整执行，skipped=跳过，partial=部分执行。 */
    status: 'completed' | 'skipped' | 'partial';
    /** 该阶段一句话摘要。 */
    summary: string;
    /** 该阶段引用的证据 id 列表。 */
    evidenceIds: string[];
  }>;
  /** 证据列表。 */
  evidence: AgentEvidence[];
  /** 辩论发言列表。 */
  debate: DebateRecord[];
}

// ─────────── 深度报告 ───────────

/**
 * 深度研究报告：full 档位运行产出的结构化报告（基本面/估值/多空/风控/交易计划）。
 * 大量字段为 null 表示该小节未生成；数值字段沿用字符串数值约定。
 */
export interface DeepReport {
  /** 报告 id。 */
  id: string;
  /** 关联运行 id。 */
  runId: string;
  /** 标的代码。 */
  ticker: string;
  /** 流水线过程追踪（各阶段状态与摘要）；无则 null。 */
  analysisTrace?: AnalysisTrace | null;
  /** 最终评级；未产出为 null。 */
  rating: AgentRating | null;
  /** 置信度；未产出为 null。 */
  confidence: AgentConfidence | null;
  /** 悲观目标价（字符串数值）；无则 null。 */
  targetBear: string | null;
  /** 基准目标价（字符串数值）；无则 null。 */
  targetBase: string | null;
  /** 乐观目标价（字符串数值）；无则 null。 */
  targetBull: string | null;
  /** 悲观情景概率（字符串数值）；无则 null。 */
  probBear: string | null;
  /** 基准情景概率（字符串数值）；无则 null。 */
  probBase: string | null;
  /** 乐观情景概率（字符串数值）；无则 null。 */
  probBull: string | null;
  /** 核心投资逻辑；无则 null。 */
  coreThesis: string | null;
  /** 相对上一次报告的观点变化说明；无则 null。 */
  viewChange: string | null;
  /** 上一次报告的评级；无则 null。 */
  prevRating: string | null;
  /** 公司概览。 */
  companyOverview: string | null;
  /** 商业模式分析。 */
  businessModel: string | null;
  /** 护城河分析。 */
  moat: string | null;
  /** 营收结构（按分部）。 */
  revenueStructure: RevenueItem[] | null;
  /** 年度财务数据。 */
  financialAnnual: FinancialPeriod[] | null;
  /** 季度财务数据。 */
  financialQuarterly: FinancialPeriod[] | null;
  /** 盈利能力指标。 */
  profitability: ProfitabilityMetric[] | null;
  /** 资产负债表要点。 */
  balanceSheet: BalanceSheetItem[] | null;
  /** 现金流要点。 */
  cashFlow: CashFlowItem[] | null;
  /** 财务质量评估。 */
  financialQuality: string | null;
  /** 分部业务分析。 */
  segmentAnalysis: SegmentItem[] | null;
  /** 相对估值（与历史分位/行业均值对比）。 */
  valuationRelative: ValuationRelativeItem[] | null;
  /** SOTP 分部加总估值。 */
  valuationSotp: SotpItem[] | null;
  /** 估值方法论说明。 */
  valuationMethodology: string | null;
  /** 行业概览。 */
  industryOverview: string | null;
  /** 市场规模。 */
  marketSize: string | null;
  /** 竞争地位。 */
  competitivePosition: string | null;
  /** 行业趋势。 */
  industryTrends: string | null;
  /** 多方论点。 */
  bullPoints: BullBearPoint[] | null;
  /** 空方论点。 */
  bearPoints: BullBearPoint[] | null;
  /** 批评方复核意见。 */
  criticPoints: CriticPoint[] | null;
  /** 批评后修订的假设说明。 */
  revisedAssumptions: string | null;
  /** 催化剂时间线。 */
  catalystsTimeline: CatalystItem[] | null;
  /** 风险清单。 */
  riskItems: RiskItem[] | null;
  /** 风控闸门结果快照。 */
  riskGateSnapshot: RiskGateResult[] | null;
  /** 投资经理（PM）决策动作。 */
  pmAction: string | null;
  /** PM 建议价格区间。 */
  pmPriceRange: string | null;
  /** PM 建议仓位大小。 */
  pmPositionSize: string | null;
  /** PM 建议止损位。 */
  pmStopLoss: string | null;
  /** PM 执行计划。 */
  pmExecutionPlan: string | null;
  /** 后续跟踪指标。 */
  trackingMetrics: TrackingMetric[] | null;
  /** 观点翻转触发条件。 */
  viewChangeTriggers: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 营收结构条目：单分部营收与占比。数值字段接受 number 或字符串数值。 */
export interface RevenueItem {
  /** 分部名称。 */
  segment: string;
  /** 分部营收。 */
  revenue: number | string;
  /** 营收占比（百分数）。 */
  sharePct: number | string;
  /** 同比增速（百分数）；未知为 null。 */
  yoyPct?: number | string | null;
}

/** 财务期数据条目：单期（年/季）营收与净利及同比。 */
export interface FinancialPeriod {
  /** 期间标识（如 "FY2024"、"2024Q3"，由产出方决定格式）。 */
  period: string;
  /** 该期营收。 */
  revenue?: number | string | null;
  /** 该期净利润。 */
  netProfit?: number | string | null;
  /** 营收同比（百分数）。 */
  revenueYoy?: number | string | null;
  /** 净利同比（百分数）。 */
  profitYoy?: number | string | null;
}

/** 盈利能力指标条目：当期值 + 可选 TTM 与行业对比。 */
export interface ProfitabilityMetric {
  /** 指标名（如毛利率、ROE）。 */
  metric: string;
  /** 当期值。 */
  value: number | string;
  /** TTM（滚动十二个月）值。 */
  ttm?: number | string | null;
  /** 行业均值/对标值。 */
  industry?: number | string | null;
}

/** 资产负债表要点条目。 */
export interface BalanceSheetItem {
  /** 项目名。 */
  item: string;
  /** 项目值。 */
  value: number | string;
  /** 备注。 */
  note?: string | null;
}

/** 现金流要点条目。 */
export interface CashFlowItem {
  /** 项目名。 */
  item: string;
  /** 项目值。 */
  value: number | string;
  /** 备注。 */
  note?: string | null;
}

/** 分部业务分析条目。 */
export interface SegmentItem {
  /** 分部名称。 */
  name: string;
  /** 分部营收。 */
  revenue?: number | string | null;
  /** 分部毛利率。 */
  grossMargin?: number | string | null;
  /** 增速（百分数）。 */
  growthPct?: number | string | null;
  /** 前景展望。 */
  outlook?: string | null;
}

/** 相对估值条目：单指标当前值 vs 5 年分位/行业均值。 */
export interface ValuationRelativeItem {
  /** 指标名（如 PE、PB）。 */
  metric: string;
  /** 当前值。 */
  current: number | string;
  /** 近 5 年分位（百分数）。 */
  percentile5y?: number | string | null;
  /** 行业均值。 */
  industryAvg?: number | string | null;
  /** 备注。 */
  note?: string | null;
}

/** SOTP（分部加总）估值条目。 */
export interface SotpItem {
  /** 分部名称。 */
  segment: string;
  /** 该分部估值。 */
  valuation: number | string;
  /** 估值方法名。 */
  method: string;
  /** 所用倍数。 */
  multiple?: number | string | null;
}

/** 深度报告中的多/空论点条目（与辩论轮次无关，是报告成文后的论点）。 */
export interface BullBearPoint {
  /** 论点 id；仅持久化后存在。 */
  id?: string;
  /** 论点标题。 */
  title: string;
  /** 论点详情。 */
  detail: string;
  /** 引用的证据 id 列表。 */
  evidenceIds?: string[];
}

/** 批评方复核条目：对原论点的质疑及是否已解决。 */
export interface CriticPoint {
  /** 条目 id；仅持久化后存在。 */
  id?: string;
  /** 被质疑的原论点。 */
  originalClaim: string;
  /** 批评意见。 */
  critique: string;
  /** 该质疑是否已在修订中解决。 */
  resolved: boolean;
  /** 修订后的表述；未修订为 null。 */
  revision?: string | null;
}

/** 催化剂条目：未来事件的时间线与影响方向。 */
export interface CatalystItem {
  /** 条目 id；仅持久化后存在。 */
  id?: string;
  /** 预期日期（字符串，格式由产出方决定）。 */
  date: string;
  /** 催化剂标题。 */
  title: string;
  /** 催化剂类型。 */
  type: 'earnings' | 'product' | 'policy' | 'industry' | 'other';
  /** 预期影响方向。 */
  impact: 'positive' | 'negative' | 'neutral';
  /** 细节说明。 */
  detail?: string | null;
}

/** 风险条目：风险描述、概率/影响分级与应对。 */
export interface RiskItem {
  /** 条目 id；仅持久化后存在。 */
  id?: string;
  /** 风险描述。 */
  risk: string;
  /** 发生概率。 */
  probability: 'high' | 'medium' | 'low';
  /** 影响程度。 */
  impact: 'high' | 'medium' | 'low';
  /** 应对/缓解措施。 */
  mitigation: string;
}

/** 跟踪指标条目：持仓后持续跟踪的信号定义。 */
export interface TrackingMetric {
  /** 指标名。 */
  metric: string;
  /** 触发阈值。 */
  threshold: string;
  /** 触发方向：above=高于阈值，below=低于阈值，cross=穿越。 */
  direction: 'above' | 'below' | 'cross';
  /** 跟踪频率描述。 */
  frequency: string;
}

// ─────────── 列表查询 / 人工决策 / 批量运行 ───────────

/** 运行列表查询参数。 */
export interface AgentRunListQuery {
  /** 仅返回进行中的运行。 */
  activeOnly?: boolean;
  /** 按标的代码过滤。 */
  ticker?: string;
  /** 按状态过滤。 */
  status?: AgentRunStatus;
  /** 按档位过滤。 */
  runMode?: AgentRunMode;
  /** 起始时间（ISO 字符串）。 */
  from?: string;
  /** 截止时间（ISO 字符串）。 */
  to?: string;
  /** 分页大小。 */
  limit?: number;
  /** 分页偏移。 */
  offset?: number;
}

/** 人工决策提交：对 awaiting_human 的运行做最终裁决，可附带修改后的评级。 */
export interface HumanDecisionDto {
  /** 决策结果（不含 pending：pending 是初始态，不是可提交的决策）。 */
  decision: 'approved' | 'modified' | 'rejected';
  /** 决策备注。 */
  note?: string;
  /** decision=modified 时提供的修改后评级。 */
  modifiedRating?: {
    /** 修改后评级。 */
    rating: AgentRating;
    /** 修改后置信度。 */
    confidence: AgentConfidence;
    /** 修改后目标价；写入 DTO 用 number。 */
    targetPrice?: number;
    /** 修改后建议动作。 */
    action: string;
    /** 多方小结。 */
    bullSummary?: string;
    /** 空方小结。 */
    bearSummary?: string;
    /** 催化剂。 */
    catalysts?: string;
    /** 风险点。 */
    risks?: string;
  };
  /** 是否把评级同步落到持仓（Holding.rating 等字段）。 */
  applyToHoldings?: boolean;
  /** 是否同步写入 Analysis（人工分析记录）。 */
  syncToAnalysis?: boolean;
}

/** 批量运行请求：对一批标的各建一个多智能体运行。 */
export interface BatchRunRequest {
  /** 分析输出语言。 */
  language?: AnalysisLanguage;
  /** 选股范围：holdings=持仓，watchlist=自选，all=两者全部，custom=由 tickers 指定。 */
  scope: 'holdings' | 'watchlist' | 'all' | 'custom';
  /** scope=custom 时的标的列表。 */
  tickers?: string[];
  /** 分层运行开关：true 时高确信标的全量、其余摘要。 */
  tiered: boolean;
}

/** 批量运行中的单个运行条目。 */
export interface BatchRunItem {
  /** 运行 id。 */
  runId: string;
  /** 标的代码。 */
  ticker: string;
  /** 运行档位。 */
  runMode: AgentRunMode;
  /** 运行状态。 */
  status: AgentRunStatus;
}

/** 批量运行结果：计数 + 明细 + 逐标的失败原因。 */
export interface BatchRunResult {
  /** 成功创建的运行数。 */
  created: number;
  /** 进入队列等待的运行数。 */
  queued: number;
  /** 立即开始运行的运行数。 */
  running: number;
  /** 各标的运行条目。 */
  runs: BatchRunItem[];
  /** 创建失败的标的与原因。 */
  errors: Array<{ /** 失败标的。 */ ticker: string; /** 失败原因。 */ error: string }>;
}

/** 深度报告列表条目（列表页轻量视图，无正文）。 */
export interface DeepReportListItem {
  /** 关联运行 id。 */
  runId: string;
  /** 标的代码。 */
  ticker: string;
  /** 标的名称；未知为 null。 */
  tickerName: string | null;
  /** 评级；未产出为 null。 */
  rating: string | null;
  /** 置信度；未产出为 null。 */
  confidence: string | null;
  /** 悲观目标价（字符串数值）；无则 null。 */
  targetBear: string | null;
  /** 基准目标价（字符串数值）；无则 null。 */
  targetBase: string | null;
  /** 乐观目标价（字符串数值）；无则 null。 */
  targetBull: string | null;
  /** 报告日期。 */
  reportDate: string;
  /** 运行完成时间（ISO 字符串）。 */
  completedAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 已平仓盈亏单标的条目（按标的聚合全部平仓记录）。 */
export interface RealizedPlItem {
  /** 标的代码。 */
  ticker: string;
  /** 公司名；未知为 null。 */
  company: string | null;
  /** 已实现盈亏合计（字符串数值，币种见 currency）。 */
  realizedPl: string;
  /** 收益率（百分数，字符串数值）；无基准则 null。 */
  returnPct: string | null;
  /** 累计平仓股数（字符串数值）。 */
  totalShares: string;
  /** 平仓次数。 */
  closeCount: number;
  /** 最近一次平仓日期。 */
  lastCloseDate: string;
  /** 计价币种代码。 */
  currency: string;
}

/** 已平仓盈亏汇总：分币种合计 + 盈利/亏损标的数。 */
export interface RealizedPlSummary {
  /** 按币种合计的已实现盈亏（键=币种代码，值=字符串数值）。 */
  totalByCurrency: Record<string, string>;
  /** 盈利标的数。 */
  totalWinners: number;
  /** 亏损标的数。 */
  totalLosers: number;
  /** 各标的明细。 */
  items: RealizedPlItem[];
}

/** 某标的最近一次智能体评级快照（列表页展示用）。 */
export interface LatestRating {
  /** 标的代码。 */
  ticker: string;
  /** 评级。 */
  rating: AgentRating;
  /** 置信度。 */
  confidence: AgentConfidence;
  /** 目标价（字符串数值）；无则 null。 */
  targetPrice: string | null;
  /** 建议动作文本。 */
  action: string;
  /** 来源运行 id。 */
  runId: string;
  /** 评级时间（ISO 字符串）。 */
  createdAt: string;
  /** 多方小结；无则 null。 */
  bullSummary: string | null;
  /** 空方小结；无则 null。 */
  bearSummary: string | null;
}

/** 运行列表条目（带评级关联）：列表页在 AgentRun 基础上附最新评级与是否有报告。 */
export interface AgentRunWithRating extends AgentRun {
  /** 是否已生成深度报告。 */
  hasReport?: boolean;
  /** 关联的评级记录；未产出为 null。 */
  rating: AgentRatingRecord | null;
}

/** 每日批量运行结果：持仓与自选两组运行条目 + 计数。 */
export interface DailyBatchResult {
  /** 持仓标的的运行条目。 */
  holdingsRuns: BatchRunItem[];
  /** 自选标的的运行条目。 */
  watchlistRuns: BatchRunItem[];
  /** 创建的运行总数。 */
  totalCreated: number;
  /** 创建失败的标的与原因。 */
  errors: Array<{ /** 失败标的。 */ ticker: string; /** 失败原因。 */ error: string }>;
}

/**
 * 投资组合上下文：喂给智能体的组合快照（市值/现金/集中度）。
 * 供风控与辩论阶段引用；数值字段全部为运行时 number。
 */
export interface PortfolioContext {
  /** 组合总市值（含现金）。 */
  totalValue: number;
  /** 持仓市值合计。 */
  totalMv: number;
  /** 现金合计。 */
  cash: number;
  /** 现金占比（百分数）。 */
  cashRatio: number;
  /** 各持仓明细。 */
  holdings: Array<{
    /** 标的代码。 */
    ticker: string;
    /** 公司名；未知为 null。 */
    company: string | null;
    /** 行业板块；未知为 null。 */
    sector: string | null;
    /** 市场。 */
    market: string;
    /** 币种代码。 */
    currency: string;
    /** 持股数。 */
    shares: number;
    /** 当前价。 */
    currentPrice: number;
    /** 成本价；未知为 null。 */
    costPrice: number | null;
    /** 持仓市值。 */
    marketValue: number;
    /** 组合内权重（百分数）。 */
    weightPct: number;
    /** 浮动盈亏（百分数）；无成本基准则 null。 */
    pnlPct: number | null;
    /** 所属公司分组名。 */
    companyGroup: string;
  }>;
  /** 同一公司的跨标的敞口聚合（键=公司分组名，值=市值）。 */
  companyExposures: Record<string, number>;
}

// ══════════ 认证 / 账户域 ══════════

/**
 * 认证：第一方账户体系（实现见 server/modules/auth）。
 *
 * 隐私姿态：账户 = 用户名 + bcrypt 密码哈希。不要手机号、不做邮箱验证；
 * emailNotify 只是通知系统的可选投递地址，永远不是必填项。
 */
export interface AuthUser {
  /** 用户 id。 */
  id: string;
  /** 用户名（登录凭据之一，唯一）。 */
  username: string;
  /** 显示名；未设置为 null。 */
  displayName: string | null;
}

/** 用户资料：AuthUser + 通知邮箱（仅用于通知投递，不参与登录/验证）。 */
export interface AuthProfile extends AuthUser {
  /** 通知邮箱；未设置为 null。 */
  emailNotify: string | null;
}

/** 登录/注册成功后返回的令牌集合。 */
export interface AuthTokens {
  /** 用户基本信息。 */
  user: AuthUser;
  /** 访问令牌（JWT，随请求携带）。 */
  accessToken: string;
  /** 刷新令牌（用于换发新的 accessToken）。 */
  refreshToken: string;
  /** 仅在注册或账户找回时生成一次，务必自行妥善保存。 */
  recoveryCode?: string;
}

/** 注册开关状态：服务端是否开放新用户注册。 */
export interface RegistrationStatus {
  /** 是否开放注册。 */
  registrationOpen: boolean;
}

/** 登录请求。 */
export interface LoginDto {
  /** 用户名。 */
  username: string;
  /** 密码（明文经 HTTPS 传输，服务端只存 bcrypt 哈希）。 */
  password: string;
}

/** 注册请求。 */
export interface RegisterDto {
  /** 用户名。 */
  username: string;
  /** 密码。 */
  password: string;
  /** 显示名；可省略。 */
  displayName?: string;
}

// ══════════ AI 模拟盘域 ══════════

/**
 * AI 模拟盘（Paper Trading）——与真实持仓/交易记录完全隔离的模拟账户体系。
 * 金额/价格/股数等字段沿用字符串数值约定。
 */
export type PaperSide = 'buy' | 'sell';
export type PaperOrderStatus =
  'pending' | 'pending_approval' | 'filled' | 'rejected_risk' | 'cancelled' | 'failed';
export type PaperOrderSource = 'agent' | 'manual';
export type PaperEventType =
  | 'bot_started'
  | 'bot_stopped'
  | 'bot_scan'
  | 'order_placed'
  | 'order_filled'
  | 'order_rejected'
  | 'circuit_breaker'
  | 'manual_action'
  | 'account_reset';

/** 模拟盘风控红线：触发即限制机器人行为。 */
export interface PaperGuardrails {
  /** 当日权益较开盘回撤达到该百分数时，机器人当日停机。 */
  dailyLossLimitPct: number;
  /** 单笔订单名义金额占权益的最大百分数。 */
  maxOrderPct: number;
  /** 机器人每日最大下单笔数。 */
  maxOrdersPerDay: number;
}

/** 模拟盘账户主体。 */
export interface PaperAccount {
  /** 账户 id。 */
  id: string;
  /** 基准币种代码。 */
  baseCurrency: string;
  /** 初始资金（字符串数值）。 */
  initialCash: string;
  /** 当前现金余额（字符串数值）。 */
  cashBalance: string;
  /** 自动交易机器人是否开启。 */
  botEnabled: boolean;
  /** 风控红线配置。 */
  guardrails: PaperGuardrails;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 模拟盘持仓。 */
export interface PaperPosition {
  /** 持仓 id。 */
  id: string;
  /** 标的代码。 */
  ticker: string;
  /** 市场。 */
  market: Market;
  /** 币种。 */
  currency: Currency;
  /** 公司名；未知为 null。 */
  company: string | null;
  /** 持股数（字符串数值）。 */
  shares: string;
  /** 平均成本（字符串数值）。 */
  avgCost: string;
  /** 建仓时间（ISO 字符串）。 */
  openedAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 模拟盘订单。 */
export interface PaperOrder {
  /** 订单 id。 */
  id: string;
  /** 标的代码。 */
  ticker: string;
  /** 市场。 */
  market: Market;
  /** 币种。 */
  currency: Currency;
  /** 公司名；未知为 null。 */
  company: string | null;
  /** 买卖方向。 */
  side: PaperSide;
  /** 订单类型：market=市价，limit=限价。 */
  orderType: 'market' | 'limit';
  /** 委托数量（字符串数值）。 */
  quantity: string;
  /** 限价（字符串数值）；市价单为 null。 */
  limitPrice: string | null;
  /** 订单状态。 */
  status: PaperOrderStatus;
  /** 下单来源：agent=机器人，manual=人工。 */
  source: PaperOrderSource;
  /** 下单理由（机器人给出）；无则 null。 */
  reason: string | null;
  /** 策略备注；无则 null。 */
  strategyNote: string | null;
  /** 风控检查明细（自由 JSON）；未记录为 null。 */
  riskCheck: Record<string, unknown> | null;
  /** 成交价（字符串数值）；未成交为 null。 */
  filledPrice: string | null;
  /** 成交时间（ISO 字符串）；未成交为 null。 */
  filledAt: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 模拟盘成交记录。 */
export interface PaperTrade {
  /** 成交 id。 */
  id: string;
  /** 关联订单 id。 */
  orderId: string;
  /** 标的代码。 */
  ticker: string;
  /** 市场。 */
  market: Market;
  /** 买卖方向。 */
  side: PaperSide;
  /** 成交数量（字符串数值）。 */
  quantity: string;
  /** 成交价（字符串数值）。 */
  price: string;
  /** 手续费（字符串数值）。 */
  fee: string;
  /** 本次成交的实现盈亏（字符串数值）；买入口为 null。 */
  realizedPl: string | null;
  /** 成交后现金余额（字符串数值）。 */
  cashAfter: string;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 模拟盘事件：机器人启停、下单、熔断等动作留痕。 */
export interface PaperEvent {
  /** 事件 id。 */
  id: string;
  /** 事件类型。 */
  eventType: PaperEventType;
  /** 事件明细（自由 JSON）；无则 null。 */
  detail: Record<string, unknown> | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 权益曲线单点：某日的账户截面。 */
export interface PaperSnapshotPoint {
  /** 日期。 */
  date: string;
  /** 当日总权益（字符串数值）。 */
  equity: string;
  /** 当日现金（字符串数值）。 */
  cash: string;
  /** 当日持仓市值（字符串数值）。 */
  positionsValue: string;
  /** 当日盈亏（字符串数值）。 */
  dailyPl: string;
}

/** 模拟盘总览：账户 + 持仓（附实时估值）+ 盈亏 + 曲线 + 近期订单/事件。 */
export interface PaperOverview {
  /** 账户主体。 */
  account: PaperAccount;
  /** 持仓列表（附最新价/市值/浮盈）。 */
  positions: Array<
    PaperPosition & {
      /** 最新价（字符串数值）；取价失败为 null。 */
      lastPrice: string | null;
      /** 持仓市值（字符串数值）；取价失败为 null。 */
      marketValue: string | null;
      /** 浮动盈亏（字符串数值）；取价失败为 null。 */
      unrealizedPl: string | null;
      /** 浮动盈亏率（字符串数值）；取价失败为 null。 */
      unrealizedPct: string | null;
    }
  >;
  /** 当前总权益（字符串数值）。 */
  equity: string;
  /** 持仓市值合计（字符串数值）。 */
  positionsValue: string;
  /** 今日盈亏（字符串数值）；无当日数据为 null。 */
  todayPl: string | null;
  /** 累计盈亏（字符串数值）。 */
  totalPl: string;
  /** 累计盈亏率（字符串数值）。 */
  totalPlPct: string;
  /** 今日机器人下单笔数。 */
  todayOrderCount: number;
  /** 当日熔断（红线触发停机）是否生效。 */
  circuitBreakerActive: boolean;
  /** 权益曲线（按日）。 */
  curve: PaperSnapshotPoint[];
  /** 近期订单。 */
  recentOrders: PaperOrder[];
  /** 近期事件。 */
  recentEvents: PaperEvent[];
}

/** 创建模拟盘订单请求（人工下单；写入 DTO 数值用 number）。 */
export interface CreatePaperOrderDto {
  /** 标的代码。 */
  ticker: string;
  /** 买卖方向。 */
  side: PaperSide;
  /** 委托数量。 */
  quantity: number;
  /** 订单类型；缺省 market。 */
  orderType?: 'market' | 'limit';
  /** 限价；限价单必填。 */
  limitPrice?: number;
  /** 下单理由。 */
  reason?: string;
}

// ══════════ 新手智能体构建器域 ══════════

/** 模板档位：guard=保守护盾，scout=探索扫描，balanced=均衡。 */
export type BuilderTemplate = 'guard' | 'scout' | 'balanced';
/** 构建器生命周期状态。 */
export type BuilderStatus = 'draft' | 'active' | 'paused';
/** 提案状态：pending=待人工确认，skipped=放弃，recorded=已记为成交。 */
export type BuilderProposalStatus = 'pending' | 'skipped' | 'recorded';

/**
 * 构建器配置：每个所有者同一时间只能激活一个新手构建的模拟盘智能体。
 * 无人值守时按此配置自动评审并产出提案，人工确认后才执行。
 */
export interface BuilderConfig {
  /** 无人值守评审使用的语言，在投资者保存配置时捕获。 */
  language?: 'zh-CN' | 'en';
  /** 智能体名称。 */
  name: string;
  /** 模板档位。 */
  template: BuilderTemplate;
  /** 覆盖的标的列表；为空表示覆盖全部持仓与自选。 */
  tickers: string[];
  /** 投资者手工设定的价格触发线；不代表 AI 评级。 */
  priceRules?: Array<{
    /** 标的代码。 */
    ticker: string;
    /** 买入触发价：市价不高于该值时提示买入。 */
    buyAtOrBelow?: number;
    /** 卖出触发价：市价不低于该值时提示卖出。 */
    sellAtOrAbove?: number;
  }>;
  /** 采纳提案的最低评级门槛（仅 Buy / Strong Buy 两档）。 */
  minimumRating: 'Buy' | 'Strong Buy';
  /** 给评审模型的附加指令；只是提示词，绝不是硬性风控规则。 */
  customPrompt: string;
  /** 单笔订单名义金额占权益最大百分数。 */
  maxOrderPct: number;
  /** 当日权益回撤停机线（百分数）。 */
  dailyLossLimitPct: number;
  /** 每日最大订单数。 */
  maxOrdersPerDay: number;
  /** 产出提案时是否推送通知。 */
  notifyOnProposal: boolean;
  /** 议会评审配置；旧配置缺省时使用基础规则与保守节奏。 */
  council?: import('./council.interface').CouncilConfig;
  /** 交易节奏；旧配置缺省时使用保守节奏。 */
  cadence?: import('./council.interface').TradingCadence;
}

/** 构建器档案：配置 + 状态 + 版本号（配置变更递增，提案按版本追溯）。 */
export interface BuilderProfile {
  /** 档案 id。 */
  id: string;
  /** 构建器配置。 */
  config: BuilderConfig;
  /** 生命周期状态。 */
  status: BuilderStatus;
  /** 配置版本号，每次修改递增。 */
  version: number;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 构建器提案：一次买入/卖出建议，经人工确认后落为模拟盘订单。 */
export interface BuilderProposal {
  /** 提案 id。 */
  id: string;
  /** 产生该提案的档案 id。 */
  profileId: string;
  /** 产生该提案时的档案版本号。 */
  profileVersion: number;
  /** 标的代码。 */
  ticker: string;
  /** 市场。 */
  market: Market;
  /** 币种。 */
  currency: Currency;
  /** 买卖方向。 */
  side: PaperSide;
  /** 建议数量（字符串数值）。 */
  quantity: string;
  /** 提案生成时的参考价（字符串数值）。 */
  referencePrice: string;
  /** 提案理由。 */
  reason: string;
  /** 提案状态。 */
  status: BuilderProposalStatus;
  /** 确认后落成的模拟盘订单 id；未执行为 null。 */
  paperOrderId: string | null;
  /** 实际执行时间（ISO 字符串）；未执行为 null。 */
  executedAt: string | null;
  /** 实际执行数量（字符串数值）；未执行为 null。 */
  executedQuantity: string | null;
  /** 实际执行价格（字符串数值）；未执行为 null。 */
  executedPrice: string | null;
  /** 实际执行费用（字符串数值）；未执行为 null。 */
  executedFees: string | null;
  /** 人工备注；无则 null。 */
  notes: string | null;
  /** 提案过期时间（ISO 字符串），过期自动失效。 */
  expiresAt: string;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** 构建器预演：按当前配置对样例情形给出裁决，用于保存前预览行为。 */
export interface BuilderPreview {
  /** 各情形的裁决结果。 */
  scenarios: Array<{
    /** 情形键。 */
    key: string;
    /** 裁决：paper=落为模拟盘订单，wait=暂缓，block=拦截。 */
    result: 'paper' | 'wait' | 'block';
    /** 裁决解释。 */
    explanation: string;
  }>;
}

/** 人工录入提案成交结果请求（写入 DTO 数值用 number）。 */
export interface RecordBuilderFillDto {
  /** 成交时间（ISO 字符串）。 */
  executedAt: string;
  /** 成交数量。 */
  quantity: number;
  /** 成交价。 */
  price: number;
  /** 手续费。 */
  fees: number;
  /** 备注。 */
  notes?: string;
}

// ══════════ 集成配置域 ══════════

/**
 * LLM 与财务数据源的集成状态。用户自备的凭据（API key）绝不通过 API 回传。
 * 掩码形式见 maskedApiKey；hasApiKey 只表示是否已保存过密钥。
 */
export interface IntegrationSettings {
  /** 大模型集成状态。 */
  llm: {
    /** 密钥来源：user=用户自备，server=服务端配置，builtin=内置。 */
    source: 'user' | 'server' | 'builtin';
    /** 执行引擎：basic=公开数据+确定性规则（不用语言模型），llm=大模型流水线。 */
    engine: 'basic' | 'llm';
    /** 当前是否可用。 */
    available: boolean;
    /** 服务端点。 */
    baseUrl: string;
    /** 快通道模型名。 */
    fastModel: string;
    /** 慢通道模型名。 */
    slowModel: string;
    /** 是否已保存 API key（不回传密钥本体）。 */
    hasApiKey: boolean;
    /** 掩码后的密钥（如 ••••abcd）；可选。 */
    maskedApiKey?: string;
    /** 宿主加密密钥变更后旧凭据不可读，需要重新录入。 */
    needsReentry?: boolean;
  };
  /** 财务数据源集成状态。 */
  financial: {
    /** 密钥来源：user=用户自备，builtin=内置公开源。 */
    source: 'user' | 'builtin';
    /** 财务数据提供商。 */
    provider: 'finnhub' | 'public';
    /** 当前是否可用。 */
    available: boolean;
    /** 是否已保存 API key。 */
    hasApiKey: boolean;
    /** 掩码后的密钥；可选。 */
    maskedApiKey?: string;
    /** 宿主加密密钥变更后旧凭据不可读，需要重新录入。 */
    needsReentry?: boolean;
  };
}

/** 更新 LLM 集成请求。 */
export interface UpdateLlmIntegrationRequest {
  /** 服务端点。 */
  baseUrl: string;
  /** 快通道模型名。 */
  fastModel: string;
  /** 慢通道模型名。 */
  slowModel: string;
  /** API key；省略或传空串表示保留已保存的密钥。 */
  apiKey?: string;
}

/** 更新财务数据源集成请求。 */
export interface UpdateFinancialIntegrationRequest {
  /** 财务数据提供商（当前仅支持 finnhub）。 */
  provider: 'finnhub';
  /** API key；省略或传空串表示保留已保存的密钥。 */
  apiKey?: string;
}

/** 集成连通性测试结果。 */
export interface IntegrationTestResult {
  /** 测试是否通过。 */
  ok: boolean;
  /** 结果说明文本。 */
  message: string;
  /** 结果代码：basic_ready=基础模式就绪，public_ready=公开源就绪，public_unavailable=公开源不可用，credential_unreadable=凭据不可读。 */
  code?: 'basic_ready' | 'public_ready' | 'public_unavailable' | 'credential_unreadable';
}

// ══════════ 通知渠道域 ══════════

/**
 * 通知渠道（自托管推送路由）：提案/运行完成等事件按此路由推送。
 * 渠道凭据存于 config（服务端保密），API 不回传敏感字段。
 */
export type NotificationChannelType = 'webhook' | 'bark' | 'serverchan' | 'smtp' | 'telegram';

/** 通知渠道配置项。 */
export interface NotificationChannel {
  /** 渠道 id。 */
  id: string;
  /** 渠道类型。 */
  channelType: NotificationChannelType;
  /** 展示标签；未设置为 null。 */
  label: string | null;
  /** 渠道参数（键值对；不同类型字段不同，如 webhook 的 url、smtp 的 host）。 */
  config: Record<string, string>;
  /** 是否启用。 */
  enabled: boolean;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
}

/** 创建通知渠道请求。 */
export interface CreateNotificationChannelDto {
  /** 渠道类型。 */
  channelType: NotificationChannelType;
  /** 展示标签。 */
  label?: string;
  /** 渠道参数键值对。 */
  config: Record<string, string>;
  /** 是否启用；缺省 true。 */
  enabled?: boolean;
}

// ══════════ 持仓导入域 ══════════

/**
 * 持仓导入（CSV / Robinhood CSV / 截图 OCR）：先解析出候选行，确认后提交落库。
 */
export type ImportSource = 'csv' | 'robinhood' | 'ocr';

/** 导入候选行：解析产物，用户确认后按行落库。数值字段接受 number 或字符串数值。 */
export interface ImportRowCandidate {
  /** 标的代码。 */
  ticker: string;
  /** 公司名；未知为 null。 */
  company?: string | null;
  /** 股数。 */
  shares: number | string;
  /** 平均成本；未知为 null。 */
  avgCost?: number | string | null;
  /** 当前价；未知为 null。 */
  currentPrice?: number | string | null;
  /** 币种代码；未知为 null。 */
  currency?: string | null;
}

/** 提交导入请求：把确认后的候选行写入持仓。 */
export interface ImportCommitDto {
  /** 导入来源。 */
  source: ImportSource;
  /** 确认后的候选行。 */
  rows: ImportRowCandidate[];
  /** 来源文件名；OCR 来源可省略。 */
  filename?: string;
  /** 统一买入日期；省略则由服务端决定。 */
  buyDate?: string;
}

/** 导入提交结果。 */
export interface ImportCommitResult {
  /** 本次导入的日志 id（用于追溯 ImportHistoryItem）。 */
  logId: string;
  /** 成功创建的行数。 */
  created: number;
  /** 跳过的行数。 */
  skipped: number;
  /** 失败行及原因。 */
  failed: Array<{ /** 失败标的。 */ ticker: string; /** 失败原因。 */ reason: string }>;
}

/** 导入历史条目。 */
export interface ImportHistoryItem {
  /** 记录 id。 */
  id: string;
  /** 导入来源。 */
  source: ImportSource;
  /** 来源文件名；无则 null。 */
  filename: string | null;
  /** 解析总行数。 */
  rowsTotal: number;
  /** 实际导入行数。 */
  rowsImported: number;
  /** 失败行及原因。 */
  errors: Array<{ /** 失败标的。 */ ticker: string; /** 失败原因。 */ reason: string }>;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

/** OCR 提取请求：把券商截图交给视觉模型解析出候选行。 */
export interface OcrExtractDto {
  /** 截图内容的 base64 编码。 */
  imageBase64: string;
  /** 用户自备的 API key（本请求即时使用，不落库）。 */
  apiKey: string;
  /** 模型服务端点；省略用默认。 */
  baseUrl?: string;
  /** 视觉模型名。 */
  model: string;
}

/** OCR 提取结果。 */
export interface OcrExtractResult {
  /** 识别出的券商名；未能识别为 null。 */
  broker: string | null;
  /** 解析出的候选行。 */
  rows: ImportRowCandidate[];
}

// ══════════ 外部智能体会话域 ══════════

/**
 * 外部智能体会话：给 MCP 等外部智能体发放的 API 访问凭据（类 Robinhood 模式）。
 * 会话可限权（只读/可交易）、限额（日交易上限）、可吊销。
 */
export type AgentPermission = 'read' | 'trade';
/** 审批模式：auto=自动执行，require_approval=人工审批后执行。 */
export type AgentApprovalMode = 'auto' | 'require_approval';

/** 外部智能体会话。 */
export interface AgentSession {
  /** 会话 id。 */
  id: string;
  /** 会话名称。 */
  name: string;
  /** 日交易上限（美元，字符串数值）。 */
  dailyLimitUsd: string;
  /** 权限级别。 */
  permission: AgentPermission;
  /** 审批模式。 */
  approvalMode: AgentApprovalMode;
  /** 会话状态：active=生效，revoked=已吊销。 */
  status: 'active' | 'revoked';
  /** 最近使用时间（ISO 字符串）；从未使用为 null。 */
  lastUsedAt: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 仅创建响应中返回一次，之后任何接口都不再回传。 */
  token?: string;
}

/** 创建外部智能体会话请求。 */
export interface CreateAgentSessionDto {
  /** 会话名称。 */
  name: string;
  /** 日交易上限（美元）；省略用服务端默认。 */
  dailyLimitUsd?: number;
  /** 权限级别；省略 read。 */
  permission?: AgentPermission;
  /** 审批模式；省略 require_approval。 */
  approvalMode?: AgentApprovalMode;
}

/** 模拟盘订单状态的超集：在基础状态上补充审批流专用的 pending_approval。 */
export type PaperOrderStatusWithApproval = PaperOrderStatus | 'pending_approval';

/** 模拟盘订单的下单方信息：外部智能体会话来源时非空。 */
export interface AgentOrderInfo {
  /** 下单会话 id；人工下单为 null。 */
  sessionId: string | null;
  /** 下单智能体名；人工下单为 null。 */
  agentName: string | null;
}

// ══════════ 市场总览域 ══════════

/**
 * 公共指数行情：与用户持仓及自选报价相互独立（不受用户报价配置影响）。
 * 数值字段失败抓取时为 null；数据源当前为腾讯行情。
 */
export interface MarketIndexQuote {
  /** 指数条目 id。 */
  id: string;
  /** 所属市场。 */
  market: Market;
  /** 指数点位；抓取失败为 null。 */
  value: number | null;
  /** 涨跌点数；抓取失败为 null。 */
  change: number | null;
  /** 涨跌幅（百分数）；抓取失败为 null。 */
  changePercent: number | null;
  /** 数据源本地时间，与 timeZone 配对读取（绝不是 HTTP 抓取时间）。 */
  quoteTime: string | null;
  /** 交易日（如 2026-11-14）；无则 null。 */
  sessionDate: string | null;
  /** quoteTime 的 IANA 时区名。 */
  timeZone: string;
  /** 本端抓取时间（ISO 字符串）；未抓取为 null。 */
  retrievedAt: string | null;
  /** 数据源（当前固定为腾讯）。 */
  source: 'Tencent';
  /** 数据新鲜度：available=可用，stale=过期但仍展示，unavailable=不可用。 */
  status: 'available' | 'stale' | 'unavailable';
  /** 不可用/降级原因：fetch_failed=抓取失败，invalid_quote=数据无效，outdated_quote=数据过期；正常为 null。 */
  issue: 'fetch_failed' | 'invalid_quote' | 'outdated_quote' | null;
}

/**
 * 市场情绪分：基于成分股当日涨跌幅的均价推导。
 * 这是明确标注口径的价格估算，不是官方恐贪指数。
 */
export interface MarketMood {
  /** 市场。 */
  market: Market;
  /** 情绪分（0-100 区间由 method 口径决定）；样本不足为 null。 */
  score: number | null;
  /** 成分股平均涨跌幅（百分数）。 */
  averageChangePercent: number | null;
  /** 交易日；无则 null。 */
  sessionDate: string | null;
  /** 参与计算的成分股数。 */
  covered: number;
  /** 成分股总数。 */
  total: number;
  /** 计算口径版本号（用于追溯算法变更）。 */
  method: 'index_daily_change_v1';
}

/** 市场总览响应：指数行情 + 情绪分，附带缓存刷新提示。 */
export interface MarketOverviewResponse {
  /** 本次计算时间（ISO 字符串）。 */
  checkedAt: string;
  /** 建议客户端在 N 秒后再刷新（服务端节流提示）。 */
  refreshAfterSeconds: number;
  /** 指数行情列表。 */
  indices: MarketIndexQuote[];
  /** 各市场情绪分列表。 */
  moods: MarketMood[];
}
