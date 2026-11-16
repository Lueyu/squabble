/**
 * @file api/index.ts
 * @description 组合投资后端的类型化 HTTP 封装中枢（全站 API 唯一入口）。
 *
 * 这里的每个函数都是对本地 `http` 实例（./http.ts，自动附带当前账号认证 token、
 * 统一处理 401 刷新与错误）的一层薄封装：调用方直接拿到 `response.data`（或其
 * 派生列表，例如分页响应里的 `items` 数组）。
 *
 * 覆盖的后端面：
 *  - Dashboard：总览、每日盈亏序列
 *  - 持仓 / 自选清单 / 分组：CRUD + 批量价格更新
 *  - 交易记录：列表/创建、自动入金买入、对账
 *  - 已平仓：列表、已实现盈亏汇总、手动创建
 *  - Journal / 历史快照 / Alpha picks
 *  - 多智能体研究：runs 生命周期、人工决策、评级、策略规则、深度报告
 *  - 行情搜索、现金账户、组合上下文
 *  - 认证、纸面交易、通知渠道、截图导入、MCP 智能体会话
 *
 * 注意：多数创建/更新负载仍以 `unknown` 类型传入；服务端契约才是权威，
 * 页面自行构造要发送的对象。
 *
 * 职责边界：
 *  - 只做 HTTP 调用与数据透传，不含业务逻辑、缓存或状态管理
 *  - 类型契约集中在 @shared/api.interface，本文件不重复定义
 * 上下游：
 *  - 上游（谁调用这里）：client 各页面与 hooks（Dashboard、Holdings、Watchlist、
 *    Transactions、Journal、Analysis、Paper、Import、StrategyRules、Settings、Layout 等）
 *  - 下游（本文件调用谁）：./http（axios 实例）；并向外透传导出 ../utils/logger
 * 关键约定：
 *  - URL 路径与查询参数名和后端路由一一对应，禁止改动任何字符串字面量
 *  - 请求失败时错误由 http 层统一抛出（含 401 刷新/跳登录），本文件不做捕获
 */
import http from './http';
import { logger } from '../utils/logger';

/* ============================== 仪表盘 ============================== */

/**
 * 获取仪表盘聚合总览（总资产、配置分布等）。
 * 对应 GET /api/portfolio/dashboard/overview；Dashboard、Holdings 页面首屏加载时调用。
 * @param baseCurrency - 所有金额换算成的 ISO 货币代码；默认 USD。
 * @returns 后端返回的总览数据。
 */
export async function fetchDashboard(baseCurrency: string = 'USD') {
  const response = await http({
    url: `/api/portfolio/dashboard/overview?baseCurrency=${encodeURIComponent(baseCurrency)}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * 获取仪表盘图表使用的每日盈亏序列。
 * 对应 GET /api/portfolio/dashboard/daily-pl；Dashboard 页面按所选时间范围加载时调用。
 * @param days - 返回最近 N 个交易日的数据；默认 30。
 * @param baseCurrency - 金额换算的 ISO 货币代码；默认 USD。
 * @returns 每日盈亏序列数据。
 */
export async function fetchDailyPl(days: number = 30, baseCurrency: string = 'USD') {
  const response = await http({
    url: `/api/portfolio/dashboard/daily-pl?days=${days}&baseCurrency=${encodeURIComponent(baseCurrency)}`,
    method: 'GET',
  });
  return response.data;
}

/* ============================== 持仓 ============================== */

/**
 * 获取全部在仓持仓。
 * 对应 GET /api/portfolio/holdings；Dashboard、Holdings 页面加载持仓列表时调用。
 * @returns 分页持仓响应中的 `items` 数组。
 */
export async function fetchHoldings() {
  const response = await http({
    url: '/api/portfolio/holdings',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * 新建一条持仓。
 * 对应 POST /api/portfolio/holdings；AddHoldingDialog 提交新建持仓表单时调用。
 * @param data - 持仓字段（ticker、股数、成本、币种等）。
 * @returns 新建的持仓记录。
 */
export async function createHolding(data: unknown) {
  const response = await http({
    url: '/api/portfolio/holdings',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 更新已有持仓（部分 PATCH）。
 * 对应 PATCH /api/portfolio/holdings/{id}；HoldingDetailDialog 保存编辑、调整分组时调用。
 * @param id - 持仓主键。
 * @param data - 要更新的字段。
 * @returns 更新后的持仓记录。
 */
export async function updateHolding(id: string, data: unknown) {
  const response = await http({
    url: `/api/portfolio/holdings/${id}`,
    method: 'PATCH',
    data,
  });
  return response.data;
}

/**
 * 按 id 删除持仓。
 * 对应 DELETE /api/portfolio/holdings/{id}；HoldingDetailDialog 确认删除时调用。
 * @param id - 持仓主键。
 */
export async function deleteHolding(id: string) {
  await http({
    url: `/api/portfolio/holdings/${id}`,
    method: 'DELETE',
  });
}

/* ============================== 自选清单（Watchlist） ============================== */

/**
 * 获取全部自选条目。
 * 对应 GET /api/portfolio/watchlist；WatchlistPage 加载列表时调用。
 * @returns 分页自选响应中的 `items` 数组。
 */
export async function fetchWatchlist() {
  const response = await http({
    url: '/api/portfolio/watchlist',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * 新建一条自选。
 * 对应 POST /api/portfolio/watchlist；WatchlistPage 添加自选时调用。
 * @param data - 自选字段（ticker、备注、目标价等）。
 * @returns 新建的自选记录。
 */
export async function createWatchItem(data: unknown) {
  const response = await http({
    url: '/api/portfolio/watchlist',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 更新已有自选（部分 PATCH）。
 * 对应 PATCH /api/portfolio/watchlist/{id}；Watchlist 的 DetailDialog 保存编辑时调用。
 * @param id - 自选记录主键。
 * @param data - 要更新的字段。
 * @returns 更新后的自选记录。
 */
export async function updateWatchItem(id: string, data: unknown) {
  const response = await http({
    url: `/api/portfolio/watchlist/${id}`,
    method: 'PATCH',
    data,
  });
  return response.data;
}

/**
 * 按 id 删除自选。
 * 对应 DELETE /api/portfolio/watchlist/{id}；Watchlist 的 DetailDialog 确认删除时调用。
 * @param id - 自选记录主键。
 */
export async function deleteWatchItem(id: string) {
  await http({
    url: `/api/portfolio/watchlist/${id}`,
    method: 'DELETE',
  });
}

/* ============================== 持仓分组 ============================== */

/**
 * 获取用于组织持仓的全部分组桶。
 * 对应 GET /api/portfolio/groups；HoldingsPage 加载分组列表时调用。
 * @returns 分页分组响应中的 `items` 数组。
 */
export async function fetchGroups() {
  const response = await http({
    url: '/api/portfolio/groups',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * 新建一个分组。
 * 对应 POST /api/portfolio/groups；AddHoldingDialog 在新建持仓时顺手创建缺失分组时调用。
 * @param data - 分组字段（名称、颜色等）。
 * @returns 新建的分组记录。
 */
export async function createGroup(data: unknown) {
  const response = await http({
    url: '/api/portfolio/groups',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 更新已有分组（部分 PATCH）。
 * 对应 PATCH /api/portfolio/groups/{id}；仓内当前未发现页面调用（待确认）。
 * @param id - 分组主键。
 * @param data - 要更新的字段。
 * @returns 更新后的分组记录。
 */
export async function updateGroup(id: string, data: unknown) {
  const response = await http({
    url: `/api/portfolio/groups/${id}`,
    method: 'PATCH',
    data,
  });
  return response.data;
}

/**
 * 按 id 删除分组。
 * 对应 DELETE /api/portfolio/groups/{id}；仓内当前未发现页面调用（待确认）。
 * @param id - 分组主键。
 */
export async function deleteGroup(id: string) {
  await http({
    url: `/api/portfolio/groups/${id}`,
    method: 'DELETE',
  });
}

/* ============================== 分析快照 ============================== */

/**
 * 获取每日分析快照，可按单个日期过滤。
 * 对应 GET /api/portfolio/analysis；AnalysisPage 按日期加载分析内容时调用。
 * @param date - 可选 `YYYY-MM-DD`；省略时返回最新一份快照。
 * @returns 分析记录的 `items` 数组。
 */
export async function fetchAnalysis(date?: string) {
  // 有 date 时拼查询参数，否则请求全量端点。
  const url = date ? `/api/portfolio/analysis?date=${date}` : '/api/portfolio/analysis';
  const response = await http({ url, method: 'GET' });
  return response.data.items;
}

/**
 * 获取存在分析快照的日期列表（供日期选择器使用）。
 * 对应 GET /api/portfolio/analysis/dates；AnalysisPage 初始化日期选择器时调用。
 * @returns `YYYY-MM-DD` 字符串数组，已剔除空值。
 */
export async function fetchAnalysisDates() {
  const response = await http({
    url: '/api/portfolio/analysis/dates',
    method: 'GET',
  });
  // 先兜底为空数组，再抽取 date 字段并过滤掉假值。
  const items = response.data.items || [];
  return items.map((item: { date: string }) => item.date).filter(Boolean);
}

/* ============================== 交易记录 ============================== */

/**
 * 获取交易历史，支持可选过滤条件。
 * 对应 GET /api/portfolio/transactions；TransactionsPage 加载列表（含分页）时调用。
 * @param params - 可选过滤对象。
 * @param params.ticker - 只看单个 ticker。
 * @param params.limit - 最大返回条数。
 * @param params.offset - 分页偏移。
 * @returns 交易记录的 `items` 数组。
 */
export async function fetchTransactions(params?: {
  ticker?: string;
  limit?: number;
  offset?: number;
}) {
  // 步骤 1：按传入的可选参数逐项拼装查询串（未传的字段不拼）。
  const query = new URLSearchParams();
  if (params?.ticker) query.set('ticker', params.ticker);
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));

  // 步骤 2：查询串非空才追加 `?`，避免请求空参数端点时带尾问号。
  const qs = query.toString();
  const response = await http({
    url: `/api/portfolio/transactions${qs ? `?${qs}` : ''}`,
    method: 'GET',
  });
  return response.data.items;
}

/**
 * 创建一笔买入/卖出交易。
 * 对应 POST /api/portfolio/transactions；AddTransactionDialog 提交交易表单时调用。
 * @param data - 交易字段（ticker、方向、股数、价格、日期等）。
 * @returns 新建的交易记录。
 */
export async function createTransaction(data: unknown) {
  const response = await http({
    url: '/api/portfolio/transactions',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 创建一笔自动匹配现金入金的买入交易。
 * 后端会把买入与已有入金配对，保证现金记账一致；有资金来源的买入
 * 应使用本函数而非 `createTransaction`。
 * 对应 POST /api/portfolio/transactions/auto-deposit-buy；AddTransactionDialog
 * 勾选"从入金扣款"时调用。
 * @param data - 买入交易字段 + 入金关联提示。
 * @returns 新建的交易（含关联入金）记录。
 */
export async function createTransactionWithAutoDeposit(data: unknown) {
  const response = await http({
    url: '/api/portfolio/transactions/auto-deposit-buy',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 重新执行交易、持仓与现金账户之间的对账。
 * 修正手工编辑造成的漂移；通常由管理员操作触发。
 * 对应 POST /api/portfolio/transactions/reconcile；TransactionsPage 点击对账按钮时调用。
 * @returns 对账结果摘要。
 */
export async function reconcileTransactions() {
  const response = await http({
    url: '/api/portfolio/transactions/reconcile',
    method: 'POST',
  });
  return response.data;
}

/* ============================== 已平仓 ============================== */

/**
 * 获取全部已平仓（清仓）头寸。
 * 对应 GET /api/portfolio/closed；TransactionsPage 加载"已平仓"页签时调用。
 * @returns 已平仓记录的 `items` 数组。
 */
export async function fetchClosed() {
  const response = await http({
    url: '/api/portfolio/closed',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * 跨全部已平仓头寸汇总的已实现盈亏。
 * 对应 GET /api/portfolio/closed/summary；TransactionsPage 加载汇总卡片时调用。
 * @returns 汇总数据（总已实现盈亏、胜率等）。
 */
export async function fetchRealizedPlSummary() {
  const response = await http({
    url: '/api/portfolio/closed/summary',
    method: 'GET',
  });
  return response.data;
}

/**
 * 手工新建一条已平仓记录（例如从券商对账单导入）。
 * 对应 POST /api/portfolio/closed；TransactionsPage 的 AddClosedDialog 提交时调用。
 * @param data - 已平仓字段（ticker、买/卖日期、已实现盈亏等）。
 * @returns 新建的已平仓记录。
 */
export async function createClosed(data: unknown) {
  const response = await http({
    url: '/api/portfolio/closed',
    method: 'POST',
    data,
  });
  return response.data;
}

/* ============================== Journal 与历史快照 ============================== */

/**
 * 获取交易日志（Journal）条目，可按单个日期过滤。
 * 对应 GET /api/portfolio/journal；JournalPage 加载日志列表时调用。
 * @param date - 可选 `YYYY-MM-DD`；省略时返回最新条目。
 * @returns 日志记录的 `items` 数组。
 */
export async function fetchJournal(date?: string) {
  // 有 date 时拼查询参数，否则请求全量端点。
  const url = date ? `/api/portfolio/journal?date=${date}` : '/api/portfolio/journal';
  const response = await http({ url, method: 'GET' });
  return response.data.items;
}

/**
 * 获取历史组合快照，用于长周期净值曲线。
 * 对应 GET /api/portfolio/snapshots；JournalPage 的 JournalChart 加载曲线数据时调用。
 * @param limit - 可选最大返回条数（新的在前）。
 * @returns 快照记录的 `items` 数组。
 */
export async function fetchSnapshots(limit?: number) {
  // 有 limit 时拼查询参数，否则请求全量端点。
  const url = limit ? `/api/portfolio/snapshots?limit=${limit}` : '/api/portfolio/snapshots';
  const response = await http({ url, method: 'GET' });
  return response.data.items;
}

/* ============================== Alpha picks ============================== */

/**
 * 获取 Analysis 页面展示的精选"alpha picks"列表。
 * 对应 GET /api/portfolio/alpha-picks；仓内当前未发现页面调用（待确认）。
 * @returns alpha-pick 记录的 `items` 数组。
 */
export async function fetchAlphaPicks() {
  const response = await http({
    url: '/api/portfolio/alpha-picks',
    method: 'GET',
  });
  return response.data.items;
}

/* ============================== 现金账户 ============================== */

/**
 * 获取现金账户及其余额。
 * 对应 GET /api/cash；HoldingsPage 加载现金信息时调用。
 * @returns 现金账户记录的 `items` 数组。
 */
export async function fetchCashAccounts() {
  const response = await http({
    url: '/api/cash',
    method: 'GET',
  });
  return response.data.items;
}

/* ============================== 批量价格更新 ============================== */

/**
 * 批量更新多个持仓的最新价格。
 * 手动刷新行情后使用；后端会重算市值与盈亏。
 * 对应 PATCH /api/portfolio/holdings/prices；仓内当前未发现页面调用（待确认）。
 * @param items - `{ ticker, price }` 数组。
 * @returns 更新结果摘要。
 */
export async function batchUpdatePrices(items: { ticker: string; price: number }[]) {
  const response = await http({
    url: '/api/portfolio/holdings/prices',
    method: 'PATCH',
    data: { items },
  });
  return response.data;
}

/**
 * 批量更新多个自选 ticker 的最新价格。
 * 对应 PATCH /api/portfolio/watchlist/prices；仓内当前未发现页面调用（待确认）。
 * @param items - `{ ticker, price }` 数组。
 * @returns 更新结果摘要。
 */
export async function batchUpdateWatchPrices(items: { ticker: string; price: number }[]) {
  const response = await http({
    url: '/api/portfolio/watchlist/prices',
    method: 'PATCH',
    data: { items },
  });
  return response.data;
}

/* ============================== 多智能体研究（Multi-agent） ============================== */

/**
 * 获取多智能体运行时的当前状态（排队/运行中的 run、健康度）。
 * 对应 GET /api/agent/state；仓内当前未发现页面调用（待确认）。
 * @returns 智能体状态数据。
 */
export async function fetchAgentState() {
  const response = await http({
    url: '/api/agent/state',
    method: 'GET',
  });
  return response.data;
}

/**
 * 获取多智能体运行历史（近期完成/失败的 run）。
 * 对应 GET /api/agent/history；仓内当前未发现页面调用（待确认）。
 * @returns 历史数据。
 */
export async function fetchAgentHistory() {
  const response = await http({
    url: '/api/agent/history',
    method: 'GET',
  });
  return response.data;
}

/**
 * 按可选过滤条件与分页列出多智能体研究 run。
 * 对应 GET /api/multi-agent/runs；Dashboard、Analysis、Holdings 页面加载 run 列表时调用。
 * @param params - 可选过滤对象。
 * @param params.ticker - 只看单个 ticker。
 * @param params.status - 按 run 状态过滤（queued/running/done/failed）。
 * @param params.runMode - 按 run 模式过滤（如 quick/deep）。
 * @param params.from - run 时间窗口的 ISO 起始日期。
 * @param params.to - run 时间窗口的 ISO 结束日期。
 * @param params.limit - 每页条数。
 * @param params.offset - 分页偏移。
 * @returns 分页的 runs 响应。
 */
export async function getAgentRuns(params?: {
  ticker?: string;
  status?: string;
  runMode?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}) {
  // 步骤 1：逐项拼装查询串；limit/offset 允许 0 值，故用 !== undefined 判断。
  const query = new URLSearchParams();
  if (params?.ticker) query.set('ticker', params.ticker);
  if (params?.status) query.set('status', params.status);
  if (params?.runMode) query.set('runMode', params.runMode);
  if (params?.from) query.set('from', params.from);
  if (params?.to) query.set('to', params.to);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.offset !== undefined) query.set('offset', String(params.offset));

  // 步骤 2：查询串非空才追加 `?`。
  const qs = query.toString();
  const response = await http({
    url: `/api/multi-agent/runs${qs ? `?${qs}` : ''}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * 按 id 获取单个多智能体 run（含分阶段产出）。
 * 对应 GET /api/multi-agent/runs/{id}；AgentRunDetailModal 打开详情弹窗时调用。
 * @param id - run 主键。
 * @returns run 记录。
 */
export async function getAgentRun(id: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * 新建（入队）一个多智能体研究 run。
 * run 以 `queued` 状态创建；需调用 `startAgentRun` 才会真正启动。
 * 对应 POST /api/multi-agent/runs；仓内当前未发现页面调用（待确认）。
 * @param data - run 请求字段。
 * @param data.ticker - 要研究的 ticker。
 * @param data.tickerName - 可选展示名称。
 * @param data.market - 可选市场/交易所提示。
 * @param data.triggerType - 触发方式（manual/scheduled/alert）。
 * @param data.runMode - 可选 run 模式（quick/deep）。
 * @returns 新建的 run 记录。
 */
export async function createAgentRun(data: {
  ticker: string;
  tickerName?: string;
  market?: string;
  triggerType: string;
  runMode?: string;
}) {
  const response = await http({
    url: '/api/multi-agent/runs',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 把排队中的 run 转为 `running`，让 worker 接手执行。
 * 对应 POST /api/multi-agent/runs/{id}/start；仓内当前未发现页面调用（待确认）。
 * @param id - run 主键。
 * @returns 更新后的 run 记录。
 */
export async function startAgentRun(id: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}/start`,
    method: 'POST',
  });
  return response.data;
}

/**
 * 轮询单个 run 的实时状态（run 进行中使用）。
 * 对应 GET /api/multi-agent/runs/{id}/status；仓内当前未发现页面调用（待确认）。
 * @param id - run 主键。
 * @returns 最新的状态快照。
 */
export async function getAgentRunStatus(id: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}/status`,
    method: 'GET',
  });
  return response.data;
}

/**
 * 提交人工审核者对某个待审 run 的决定。
 * 对应 POST /api/multi-agent/runs/{id}/human-decision；AgentRunDetailModal 提交审核结论时调用。
 * @param id - run 主键。
 * @param data - 决定负载。
 * @param data.decision - 所选决定（如 approve/reject/modify）。
 * @param data.note - 可选审核备注。
 * @param data.modifiedRating - 可选覆盖的评级对象。
 * @param data.applyToHoldings - 是否把决定应用到当前持仓。
 * @param data.syncToAnalysis - 是否把决定同步进分析快照。
 * @returns 更新后的 run 记录。
 */
export async function submitHumanDecision(
  id: string,
  data: {
    decision: string;
    note?: string;
    modifiedRating?: Record<string, unknown>;
    applyToHoldings?: boolean;
    syncToAnalysis?: boolean;
  },
) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}/human-decision`,
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 批量入队一组研究 run（例如全部持仓，或按优先级分层的子集）。
 * 对应 POST /api/multi-agent/runs/batch；仓内当前未发现页面调用（待确认）。
 * @param data - 批量请求。
 * @param data.scope - 覆盖哪些 ticker（all/watchlist/custom）。
 * @param data.tiered - 是否拆分为优先级分层。
 * @param data.tickers - scope 为 `custom` 时的显式 ticker 列表。
 * @returns 批量登记结果。
 */
export async function batchAgentRuns(data: { scope: string; tiered: boolean; tickers?: string[] }) {
  const response = await http({
    url: '/api/multi-agent/runs/batch',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 触发每日定时的批量研究 run。
 * 对应 POST /api/multi-agent/daily-batch；仓内当前未发现页面调用（待确认）。
 * @returns 批量登记结果。
 */
export async function dailyBatchAgentRuns() {
  const response = await http({
    url: '/api/multi-agent/daily-batch',
    method: 'POST',
  });
  return response.data;
}

/**
 * 获取一个或多个 ticker 的最新已发布评级。
 * 对应 GET /api/multi-agent/latest-ratings；HoldingsPage 刷新持仓评级时调用。
 * @param tickers - 可选 ticker 列表；省略时后端返回全部最新评级。
 * @returns 最新评级映射/列表。
 */
export async function getLatestRatings(tickers?: string[]) {
  // 只有传入非空 ticker 列表才拼 `tickers` 参数（逗号连接）。
  const query = new URLSearchParams();
  if (tickers && tickers.length > 0) query.set('tickers', tickers.join(','));
  const qs = query.toString();
  const response = await http({
    url: `/api/multi-agent/latest-ratings${qs ? `?${qs}` : ''}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * 获取全部策略规则。
 * 把两种可能的响应形态（裸数组或 `{ items }`）统一归一化为数组。
 * 对应 GET /api/multi-agent/strategy-rules；StrategyRulesPage 加载规则列表时调用。
 * @returns 策略规则记录列表。
 */
export async function getStrategyRules() {
  const response = await http({
    url: '/api/multi-agent/strategy-rules',
    method: 'GET',
  });
  // 兼容三种返回形态：裸数组、{ items: [...] }、其余一律回退空数组。
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/**
 * 新建一条策略规则。
 * 对应 POST /api/multi-agent/strategy-rules；StrategyRulesPage 新建规则时调用。
 * @param data - 规则字段（名称、条件、动作、排序等）。
 * @returns 新建的规则记录。
 */
export async function createStrategyRule(data: Record<string, unknown>) {
  const response = await http({
    url: '/api/multi-agent/strategy-rules',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * 更新已有策略规则（部分 PATCH）。
 * 对应 PATCH /api/multi-agent/strategy-rules/{id}；StrategyRulesPage 保存编辑、
 * 切换启用状态、调整阈值时调用。
 * @param id - 规则主键。
 * @param data - 要更新的字段。
 * @returns 更新后的规则记录。
 */
export async function updateStrategyRule(id: string, data: Record<string, unknown>) {
  const response = await http({
    url: `/api/multi-agent/strategy-rules/${id}`,
    method: 'PATCH',
    data,
  });
  return response.data;
}

/**
 * 按 id 删除策略规则。
 * 对应 DELETE /api/multi-agent/strategy-rules/{id}；StrategyRulesPage 确认删除时调用。
 * @param id - 规则主键。
 * @returns 删除结果。
 */
export async function deleteStrategyRule(id: string) {
  const response = await http({
    url: `/api/multi-agent/strategy-rules/${id}`,
    method: 'DELETE',
  });
  return response.data;
}

/**
 * 拖拽排序后持久化策略规则的新顺序。
 * 对应 POST /api/multi-agent/strategy-rules/reorder；StrategyRulesPage 拖拽落定时调用。
 * @param items - 反映目标顺序的 `{ id, sort }` 数组。
 * @returns 排序结果。
 */
export async function reorderStrategyRules(items: Array<{ id: string; sort: number }>) {
  const response = await http({
    url: '/api/multi-agent/strategy-rules/reorder',
    method: 'POST',
    data: { items },
  });
  return response.data;
}

/**
 * 把策略规则重置回系统默认集合。
 * 破坏性操作：会覆盖用户自定义规则。
 * 对应 POST /api/multi-agent/strategy-rules/reset-default；StrategyRulesPage 点击重置时调用。
 * @returns 重置结果。
 */
export async function resetStrategyRules() {
  const response = await http({
    url: '/api/multi-agent/strategy-rules/reset-default',
    method: 'POST',
  });
  return response.data;
}

/**
 * 获取为已完成 run 生成的版本化深度研究报告。
 * DeepReportPage 渲染这份结构化、版本化的 LLM 输出。
 * 对应 GET /api/multi-agent/deep-report/{runId}；DeepReportPage 加载报告时调用。
 * @param runId - run 主键。
 * @returns 深度报告数据。
 */
export async function getDeepReport(runId: string) {
  const response = await http({
    url: `/api/multi-agent/deep-report/${runId}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * 为某个 run 生成示例/模拟深度报告（用于演示与 UI 测试）。
 * 对应 POST /api/multi-agent/runs/{runId}/generate-sample-deep-report；仓内当前未发现页面调用（待确认）。
 * @param runId - run 主键。
 * @returns 生成的示例报告。
 */
export async function generateSampleDeepReport(runId: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${runId}/generate-sample-deep-report`,
    method: 'POST',
  });
  return response.data;
}

/* ============================== 行情搜索与组合上下文 ============================== */

/**
 * 按 ticker 或名称搜索股票（自动补全数据源）。
 * 对应 GET /api/quote/search；ticker-search.tsx 搜索联想时调用。
 * @param q - 自由文本查询；空/纯空白立即返回空结果（不发请求）。
 * @returns 匹配标的的 `items` 数组；空查询时返回 `[]`。
 */
export async function searchStocks(q: string) {
  // 空查询直接短路返回，避免无意义的网络请求。
  if (!q || !q.trim()) return [];
  const response = await http({
    url: `/api/quote/search?q=${encodeURIComponent(q.trim())}`,
    method: 'GET',
  });
  // 兼容响应形态：有 items 数组才返回，否则回退空数组。
  const data = response.data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/**
 * 获取注入智能体提示词的聚合组合上下文
 * （当前持仓、现金、近期交易、风险敞口）。
 * 对应 GET /api/multi-agent/portfolio-context；仓内当前未发现页面调用（待确认）。
 * @returns 组合上下文数据。
 */
export async function getPortfolioContext() {
  const response = await http({
    url: '/api/multi-agent/portfolio-context',
    method: 'GET',
  });
  return response.data;
}

// 向后兼容的 logger 再导出：部分调用方习惯从 '@/api' 取 logger。
export { logger };

/* ============================== 认证 / 纸面交易 / 通知 / 导入 / MCP ============================== */

/**
 * 认证域类型（第一方账号体系，见 server/modules/auth）。
 * 本 import 保持原位（文件中部），勿移动，以免改变模块初始化语义。
 */
import type {
  AuthTokens,
  AuthProfile,
  RegistrationStatus,
  LoginDto,
  RegisterDto,
  CreatePaperOrderDto,
  PaperAccount,
  PaperGuardrails,
  PaperOrder,
  PaperOverview,
  NotificationChannel,
  CreateNotificationChannelDto,
  ImportCommitDto,
  ImportCommitResult,
  ImportHistoryItem,
  OcrExtractDto,
  OcrExtractResult,
  AgentSession,
  CreateAgentSessionDto,
  AgentPermission,
  AgentApprovalMode,
} from '@shared/api.interface';

/* ---------- 认证 ---------- */

/**
 * 用户名 + 密码登录，返回签发的 JWT 会话。
 * 对应 POST /api/auth/login；LoginPage 登录表单提交时调用。
 */
export async function apiLogin(dto: LoginDto): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/login', method: 'POST', data: dto });
  return response.data;
}

/**
 * 注册账号，返回签发的 JWT 会话。
 * 对应 POST /api/auth/register；RegisterPage 注册表单提交时调用。
 */
export async function apiRegister(dto: RegisterDto): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/register', method: 'POST', data: dto });
  return response.data;
}

/**
 * 查询注册开放状态。
 * 对应 GET /api/auth/registration-status；LoginPage、RegisterPage 加载时调用。
 */
export async function fetchRegistrationStatus(): Promise<RegistrationStatus> {
  const response = await http({ url: '/api/auth/registration-status', method: 'GET' });
  return response.data;
}

/**
 * 用恢复码 + 新密码找回账号，返回新的 JWT 会话。
 * 对应 POST /api/auth/recover；RecoverPage 提交找回表单时调用。
 */
export async function apiRecoverAccount(dto: {
  username: string;
  recoveryCode: string;
  newPassword: string;
}): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/recover', method: 'POST', data: dto });
  return response.data;
}

/**
 * 校验密码后轮换恢复码，返回新的 JWT 会话。
 * 对应 POST /api/auth/recovery-code；Settings 的 RecoveryCodeCard 轮换时调用。
 */
export async function apiRotateRecoveryCode(password: string): Promise<AuthTokens> {
  const response = await http({
    url: '/api/auth/recovery-code',
    method: 'POST',
    data: { password },
  });
  return response.data;
}

/**
 * 获取调用者本人的资料（布局页用户菜单用）。
 * 对应 GET /api/auth/me；Layout 的用户菜单查询时调用。
 */
export async function fetchMyProfile(): Promise<AuthProfile> {
  const response = await http({ url: '/api/auth/me', method: 'GET' });
  return response.data;
}

/* ---------- 纸面交易 ---------- */

/**
 * 纸面交易：获取纸面页完整总览。
 * 对应 GET /api/paper/overview；PaperPage 首屏加载时调用。
 */
export async function fetchPaperOverview(): Promise<PaperOverview> {
  const response = await http({ url: '/api/paper/overview', method: 'GET' });
  return response.data;
}

/**
 * 纸面交易：下一笔手动（市价）订单。
 * 对应 POST /api/paper/orders；PaperPage 提交下单表单时调用。
 */
export async function placePaperOrder(dto: CreatePaperOrderDto): Promise<PaperOrder> {
  const response = await http({ url: '/api/paper/orders', method: 'POST', data: dto });
  return response.data;
}

/**
 * 纸面交易：启用/停用 watchbot。
 * 对应 POST /api/paper/bot/toggle；PaperPage 切换 bot 开关时调用。
 */
export async function togglePaperBot(enabled: boolean): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/bot/toggle', method: 'POST', data: { enabled } });
  return response.data;
}

/**
 * 纸面交易：立即触发一次 bot 扫描。
 * 对应 POST /api/paper/bot/run；PaperPage 点击"立即扫描"时调用。
 */
export async function runPaperBot(): Promise<{
  scanned: number;
  signals: Array<{ ticker: string; side: 'buy' | 'sell'; reason: string }>;
  placed: number;
  rejected: number;
}> {
  const response = await http({ url: '/api/paper/bot/run', method: 'POST' });
  return response.data;
}

/**
 * 纸面交易：更新风控阈值（guardrails）。
 * 对应 PUT /api/paper/guardrails；PaperPage 保存风控设置时调用。
 */
export async function updatePaperGuardrails(
  patch: Partial<PaperGuardrails>,
): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/guardrails', method: 'PUT', data: patch });
  return response.data;
}

/**
 * 纸面交易：重置账户（丢弃全部纸面数据）。
 * 对应 POST /api/paper/account/reset；PaperPage 确认重置时调用。
 */
export async function resetPaperAccount(initialCash?: number): Promise<PaperAccount> {
  const response = await http({
    url: '/api/paper/account/reset',
    method: 'POST',
    data: { initialCash },
  });
  return response.data;
}

/**
 * 纸面交易：惰性创建调用者的纸面账户。
 * 对应 POST /api/paper/account；仓内当前未发现页面调用（待确认）。
 */
export async function ensurePaperAccount(): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/account', method: 'POST' });
  return response.data;
}

/* ---------- 通知渠道 ---------- */

/**
 * 通知：列出已配置的通知渠道。
 * 对应 GET /api/notifications/channels；PaperPage 的通知设置区加载时调用。
 */
export async function fetchNotificationChannels(): Promise<NotificationChannel[]> {
  const response = await http({ url: '/api/notifications/channels', method: 'GET' });
  return response.data;
}

/**
 * 通知：新增一个渠道。
 * 对应 POST /api/notifications/channels；PaperPage 添加渠道时调用。
 */
export async function createNotificationChannel(
  dto: CreateNotificationChannelDto,
): Promise<NotificationChannel> {
  const response = await http({ url: '/api/notifications/channels', method: 'POST', data: dto });
  return response.data;
}

/**
 * 通知：启用/停用某个渠道。
 * 对应 PUT /api/notifications/channels/{id}/enabled；PaperPage 切换渠道开关时调用。
 */
export async function setNotificationChannelEnabled(id: string, enabled: boolean): Promise<void> {
  await http({
    url: `/api/notifications/channels/${id}/enabled`,
    method: 'PUT',
    data: { enabled },
  });
}

/**
 * 通知：删除某个渠道。
 * 对应 DELETE /api/notifications/channels/{id}；PaperPage 删除渠道时调用。
 */
export async function deleteNotificationChannel(id: string): Promise<void> {
  await http({ url: `/api/notifications/channels/${id}`, method: 'DELETE' });
}

/**
 * 通知：通过指定渠道发送一条测试消息。
 * 对应 POST /api/notifications/channels/{id}/test；PaperPage 点击"测试"时调用。
 */
export async function testNotificationChannel(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const response = await http({ url: `/api/notifications/channels/${id}/test`, method: 'POST' });
  return response.data;
}

/* ---------- 数据导入 ---------- */

/**
 * 导入：按映射/抽取出的行创建持仓。
 * 对应 POST /api/import/commit；ImportPage 确认导入（映射或 OCR 结果）时调用。
 */
export async function commitImport(dto: ImportCommitDto): Promise<ImportCommitResult> {
  const response = await http({ url: '/api/import/commit', method: 'POST', data: dto });
  return response.data;
}

/**
 * 导入：用用户自己的多模态 LLM key 从券商截图抽取持仓
 * （瞬时使用，服务端绝不持久化该 key）。
 * 对应 POST /api/import/ocr/extract；ImportPage 上传截图识别时调用。
 */
export async function extractScreenshot(dto: OcrExtractDto): Promise<OcrExtractResult> {
  const response = await http({
    url: '/api/import/ocr/extract',
    method: 'POST',
    data: dto,
    timeout: 120000,
  });
  return response.data;
}

/**
 * 导入：近期导入历史。
 * 对应 GET /api/import/history；ImportPage 加载历史列表时调用。
 */
export async function fetchImportHistory(): Promise<ImportHistoryItem[]> {
  const response = await http({ url: '/api/import/history', method: 'GET' });
  return response.data;
}

/* ---------- MCP 智能体会话 ---------- */

/**
 * MCP：列出智能体会话。
 * 对应 GET /api/mcp/sessions；PaperPage 的会话管理区加载时调用。
 */
export async function fetchAgentSessions(): Promise<AgentSession[]> {
  const response = await http({ url: '/api/mcp/sessions', method: 'GET' });
  return response.data;
}

/**
 * MCP：创建一个智能体会话（token 只返回一次）。
 * 对应 POST /api/mcp/sessions；PaperPage 新建会话时调用。
 */
export async function createAgentSession(dto: CreateAgentSessionDto): Promise<AgentSession> {
  const response = await http({ url: '/api/mcp/sessions', method: 'POST', data: dto });
  return response.data;
}

/**
 * MCP：更新会话的限额/模式。
 * 对应 PUT /api/mcp/sessions/{id}；PaperPage 修改会话设置时调用。
 */
export async function updateAgentSession(
  id: string,
  patch: { dailyLimitUsd?: number; permission?: AgentPermission; approvalMode?: AgentApprovalMode },
): Promise<AgentSession> {
  const response = await http({ url: `/api/mcp/sessions/${id}`, method: 'PUT', data: patch });
  return response.data;
}

/**
 * MCP：吊销一个智能体会话。
 * 对应 POST /api/mcp/sessions/{id}/revoke；PaperPage 吊销会话时调用。
 */
export async function revokeAgentSession(id: string): Promise<void> {
  await http({ url: `/api/mcp/sessions/${id}/revoke`, method: 'POST' });
}

/* ---------- 纸面交易：订单审批 ---------- */

/**
 * 纸面交易：批准一笔待审的智能体订单。
 * 对应 POST /api/paper/orders/{orderId}/approve；PaperPage 审批队列点击"批准"时调用。
 */
export async function approvePaperOrder(orderId: string): Promise<PaperOrder> {
  const response = await http({ url: `/api/paper/orders/${orderId}/approve`, method: 'POST' });
  return response.data;
}

/**
 * 纸面交易：拒绝一笔待审的智能体订单。
 * 对应 POST /api/paper/orders/{orderId}/reject；PaperPage 审批队列点击"拒绝"时调用。
 */
export async function rejectPaperOrder(orderId: string): Promise<PaperOrder> {
  const response = await http({ url: `/api/paper/orders/${orderId}/reject`, method: 'POST' });
  return response.data;
}
