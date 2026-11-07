/**
 * @file api/index.ts
 * @description Typed HTTP client for the portfolio backend.
 *
 * Every function here is a thin async wrapper around the local `http`
 * instance, which attaches the current account's auth token and handles
 * errors. Callers receive `response.data` (or a derived list).
 *
 * Backend surface covered:
 *  - Dashboard: overview, daily P/L series
 *  - Holdings / Watchlist / Groups: CRUD + batch price updates
 *  - Transactions: list/create, auto-deposit buy, reconciliation
 *  - Closed positions: list, realized-P&L summary, create
 *  - Journal / Snapshots / Alpha picks
 *  - Multi-agent research: runs lifecycle, human decisions, ratings,
 *    strategy rules, deep reports
 *  - Quote search, cash accounts, portfolio context
 *
 * Note: most create/update payloads are still typed as `unknown`; the server
 * contract is the source of truth and pages shape the objects they send.
 */
import http from './http';
import { logger } from '../utils/logger';
import type { ScreenshotExtractRequest, ScreenshotJob } from '@shared/screenshot-import.interface';

/**
 * Fetch the dashboard aggregate overview (totals, allocation, etc.).
 * @param baseCurrency - ISO currency code all amounts are converted into; defaults to USD.
 * @returns The overview payload as returned by the backend.
 */
export async function fetchDashboard(baseCurrency: string = 'USD') {
  const response = await http({
    url: `/api/portfolio/dashboard/overview?baseCurrency=${encodeURIComponent(baseCurrency)}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * Fetch the daily portfolio P/L series used by the Dashboard charts.
 * @param days - Number of trailing trading days to return; defaults to 30.
 * @param baseCurrency - ISO currency code for converted amounts; defaults to USD.
 * @returns The daily P/L series payload.
 */
export async function fetchDailyPl(days: number = 30, baseCurrency: string = 'USD') {
  const response = await http({
    url: `/api/portfolio/dashboard/daily-pl?days=${days}&baseCurrency=${encodeURIComponent(baseCurrency)}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * Fetch all open holdings.
 * @returns The `items` array from the paginated holdings response.
 */
export async function fetchHoldings() {
  const response = await http({
    url: '/api/portfolio/holdings',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Create a new holding.
 * @param data - Holding fields (ticker, shares, cost basis, currency, etc.).
 * @returns The created holding record.
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
 * Update an existing holding (partial PATCH).
 * @param id - Holding primary key.
 * @param data - Fields to update.
 * @returns The updated holding record.
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
 * Delete a holding by id.
 * @param id - Holding primary key.
 */
export async function deleteHolding(id: string) {
  await http({
    url: `/api/portfolio/holdings/${id}`,
    method: 'DELETE',
  });
}

/**
 * Fetch all watchlist items.
 * @returns The `items` array from the paginated watchlist response.
 */
export async function fetchWatchlist() {
  const response = await http({
    url: '/api/portfolio/watchlist',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Create a new watchlist item.
 * @param data - Watch fields (ticker, notes, target price, etc.).
 * @returns The created watch record.
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
 * Update an existing watchlist item (partial PATCH).
 * @param id - Watch record primary key.
 * @param data - Fields to update.
 * @returns The updated watch record.
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
 * Delete a watchlist item by id.
 * @param id - Watch record primary key.
 */
export async function deleteWatchItem(id: string) {
  await http({
    url: `/api/portfolio/watchlist/${id}`,
    method: 'DELETE',
  });
}

/**
 * Fetch all grouping buckets used to organize holdings.
 * @returns The `items` array from the paginated groups response.
 */
export async function fetchGroups() {
  const response = await http({
    url: '/api/portfolio/groups',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Create a new group.
 * @param data - Group fields (name, color, etc.).
 * @returns The created group record.
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
 * Update an existing group (partial PATCH).
 * @param id - Group primary key.
 * @param data - Fields to update.
 * @returns The updated group record.
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
 * Delete a group by id.
 * @param id - Group primary key.
 */
export async function deleteGroup(id: string) {
  await http({
    url: `/api/portfolio/groups/${id}`,
    method: 'DELETE',
  });
}

/**
 * Fetch daily analysis snapshots, optionally filtered to a single date.
 * @param date - Optional `YYYY-MM-DD`; when omitted the latest snapshot is returned.
 * @returns The `items` array of analysis records.
 */
export async function fetchAnalysis(date?: string) {
  const url = date
    ? `/api/portfolio/analysis?date=${date}`
    : '/api/portfolio/analysis';
  const response = await http({ url, method: 'GET' });
  return response.data.items;
}

/**
 * Fetch the list of dates that have an analysis snapshot (used by date pickers).
 * @returns An array of `YYYY-MM-DD` strings, with falsy entries removed.
 */
export async function fetchAnalysisDates() {
  const response = await http({
    url: '/api/portfolio/analysis/dates',
    method: 'GET',
  });
  const items = response.data.items || [];
  return items.map((item: { date: string }) => item.date).filter(Boolean);
}

/**
 * Fetch transaction history with optional filters.
 * @param params - Optional filter object.
 * @param params.ticker - Restrict to a single ticker symbol.
 * @param params.limit - Maximum number of transactions to return.
 * @returns The `items` array of transaction records.
 */
export async function fetchTransactions(params?: { ticker?: string; limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  if (params?.ticker) query.set('ticker', params.ticker);
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  const response = await http({
    url: `/api/portfolio/transactions${qs ? `?${qs}` : ''}`,
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Create a buy/sell transaction.
 * @param data - Transaction fields (ticker, side, shares, price, date, etc.).
 * @returns The created transaction record.
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
 * Create a buy transaction that automatically consumes a matching cash deposit.
 * The backend pairs the buy with an existing deposit to keep cash accounting
 * consistent; use this instead of `createTransaction` for funded purchases.
 * @param data - Buy transaction fields plus deposit linkage hints.
 * @returns The created transaction (and linked deposit) record.
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
 * Re-run reconciliation between transactions, holdings and cash accounts.
 * Corrects drift caused by manual edits; typically triggered by an admin action.
 * @returns The reconciliation result summary.
 */
export async function reconcileTransactions() {
  const response = await http({
    url: '/api/portfolio/transactions/reconcile',
    method: 'POST',
  });
  return response.data;
}

/**
 * Fetch all closed (fully sold) positions.
 * @returns The `items` array of closed-position records.
 */
export async function fetchClosed() {
  const response = await http({
    url: '/api/portfolio/closed',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Fetch the realized P&L summary aggregated across all closed positions.
 * @returns The summary payload (total realized gain/loss, win rate, etc.).
 */
export async function fetchRealizedPlSummary() {
  const response = await http({
    url: '/api/portfolio/closed/summary',
    method: 'GET',
  });
  return response.data;
}

/**
 * Manually create a closed position (e.g. imported from a broker statement).
 * @param data - Closed-position fields (ticker, buy/sell dates, realized P/L, etc.).
 * @returns The created closed-position record.
 */
export async function createClosed(data: unknown) {
  const response = await http({
    url: '/api/portfolio/closed',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * Fetch journal entries, optionally filtered to a single date.
 * @param date - Optional `YYYY-MM-DD`; when omitted the latest entries are returned.
 * @returns The `items` array of journal records.
 */
export async function fetchJournal(date?: string) {
  const url = date
    ? `/api/portfolio/journal?date=${date}`
    : '/api/portfolio/journal';
  const response = await http({ url, method: 'GET' });
  return response.data.items;
}

/**
 * Fetch historical portfolio snapshots used by long-range equity curves.
 * @param limit - Optional maximum number of snapshots to return (newest first).
 * @returns The `items` array of snapshot records.
 */
export async function fetchSnapshots(limit?: number) {
  const url = limit
    ? `/api/portfolio/snapshots?limit=${limit}`
    : '/api/portfolio/snapshots';
  const response = await http({ url, method: 'GET' });
  return response.data.items;
}

/**
 * Fetch the curated "alpha picks" list surfaced on the Analysis page.
 * @returns The `items` array of alpha-pick records.
 */
export async function fetchAlphaPicks() {
  const response = await http({
    url: '/api/portfolio/alpha-picks',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Fetch cash accounts and their balances.
 * @returns The `items` array of cash-account records.
 */
export async function fetchCashAccounts() {
  const response = await http({
    url: '/api/cash',
    method: 'GET',
  });
  return response.data.items;
}

/**
 * Bulk-update latest prices for multiple holdings.
 * Used after a manual quote refresh; the backend recomputes market values and P/L.
 * @param items - Array of `{ ticker, price }` pairs.
 * @returns The update result summary.
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
 * Bulk-update latest prices for multiple watchlist tickers.
 * @param items - Array of `{ ticker, price }` pairs.
 * @returns The update result summary.
 */
export async function batchUpdateWatchPrices(items: { ticker: string; price: number }[]) {
  const response = await http({
    url: '/api/portfolio/watchlist/prices',
    method: 'PATCH',
    data: { items },
  });
  return response.data;
}

/**
 * Fetch the current multi-agent runtime state (queued/running runs, health).
 * @returns The agent-state payload.
 */
export async function fetchAgentState() {
  const response = await http({
    url: '/api/agent/state',
    method: 'GET',
  });
  return response.data;
}

/**
 * Fetch the multi-agent run history (recent completed/failed runs).
 * @returns The history payload.
 */
export async function fetchAgentHistory() {
  const response = await http({
    url: '/api/agent/history',
    method: 'GET',
  });
  return response.data;
}

/**
 * List multi-agent research runs with optional filters and pagination.
 * @param params - Optional filter object.
 * @param params.ticker - Restrict to a single ticker.
 * @param params.status - Filter by run status (queued/running/done/failed).
 * @param params.runMode - Filter by run mode (e.g. quick/deep).
 * @param params.from - ISO start date for the run window.
 * @param params.to - ISO end date for the run window.
 * @param params.limit - Page size.
 * @param params.offset - Page offset.
 * @returns The paginated runs response.
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
  const query = new URLSearchParams();
  if (params?.ticker) query.set('ticker', params.ticker);
  if (params?.status) query.set('status', params.status);
  if (params?.runMode) query.set('runMode', params.runMode);
  if (params?.from) query.set('from', params.from);
  if (params?.to) query.set('to', params.to);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.offset !== undefined) query.set('offset', String(params.offset));
  const qs = query.toString();
  const response = await http({
    url: `/api/multi-agent/runs${qs ? `?${qs}` : ''}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * Fetch a single multi-agent run by id (including its staged outputs).
 * @param id - Run primary key.
 * @returns The run record.
 */
export async function getAgentRun(id: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * Create (enqueue) a new multi-agent research run.
 * The run starts in `queued` state; call `startAgentRun` to actually kick it off.
 * @param data - Run request fields.
 * @param data.ticker - Ticker to research.
 * @param data.tickerName - Optional display name.
 * @param data.market - Optional market/exchange hint.
 * @param data.triggerType - What triggered the run (manual/scheduled/alert).
 * @param data.runMode - Optional run mode (quick/deep).
 * @returns The created run record.
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
 * Transition a queued run into `running` so the worker picks it up.
 * @param id - Run primary key.
 * @returns The updated run record.
 */
export async function startAgentRun(id: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}/start`,
    method: 'POST',
  });
  return response.data;
}

/**
 * Poll the live status of a single run (used while a run is in progress).
 * @param id - Run primary key.
 * @returns The latest status snapshot.
 */
export async function getAgentRunStatus(id: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${id}/status`,
    method: 'GET',
  });
  return response.data;
}

/**
 * Submit a human reviewer's decision on a pending run.
 * @param id - Run primary key.
 * @param data - Decision payload.
 * @param data.decision - The chosen decision (e.g. approve/reject/modify).
 * @param data.note - Optional reviewer note.
 * @param data.modifiedRating - Optional override rating object.
 * @param data.applyToHoldings - Whether to apply the decision to current holdings.
 * @param data.syncToAnalysis - Whether to sync the decision into the analysis snapshot.
 * @returns The updated run record.
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
 * Enqueue a batch of research runs (e.g. all holdings, or a tiered subset).
 * @param data - Batch request.
 * @param data.scope - Which tickers to cover (all/watchlist/custom).
 * @param data.tiered - Whether to split work into priority tiers.
 * @param data.tickers - Explicit ticker list when scope is `custom`.
 * @returns The batch enrollment result.
 */
export async function batchAgentRuns(data: {
  scope: string;
  tiered: boolean;
  tickers?: string[];
}) {
  const response = await http({
    url: '/api/multi-agent/runs/batch',
    method: 'POST',
    data,
  });
  return response.data;
}

/**
 * Trigger the scheduled daily batch research run.
 * @returns The batch enrollment result.
 */
export async function dailyBatchAgentRuns() {
  const response = await http({
    url: '/api/multi-agent/daily-batch',
    method: 'POST',
  });
  return response.data;
}

/**
 * Fetch the latest published rating for one or more tickers.
 * @param tickers - Optional ticker list; when omitted the backend returns all latest ratings.
 * @returns A map/list of latest ratings.
 */
export async function getLatestRatings(tickers?: string[]) {
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
 * Fetch all strategy rules.
 * Normalizes two possible response shapes (bare array or `{ items }`) into an array.
 * @returns The list of strategy-rule records.
 */
export async function getStrategyRules() {
  const response = await http({
    url: '/api/multi-agent/strategy-rules',
    method: 'GET',
  });
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/**
 * Create a new strategy rule.
 * @param data - Rule fields (name, conditions, action, sort order, etc.).
 * @returns The created rule record.
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
 * Update an existing strategy rule (partial PATCH).
 * @param id - Rule primary key.
 * @param data - Fields to update.
 * @returns The updated rule record.
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
 * Delete a strategy rule by id.
 * @param id - Rule primary key.
 * @returns The delete result.
 */
export async function deleteStrategyRule(id: string) {
  const response = await http({
    url: `/api/multi-agent/strategy-rules/${id}`,
    method: 'DELETE',
  });
  return response.data;
}

/**
 * Persist a new ordering of strategy rules after drag-and-drop.
 * @param items - Array of `{ id, sort }` pairs reflecting the desired order.
 * @returns The reorder result.
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
 * Reset strategy rules back to the system default set.
 * Destructive: overrides any user-customized rules.
 * @returns The reset result.
 */
export async function resetStrategyRules() {
  const response = await http({
    url: '/api/multi-agent/strategy-rules/reset-default',
    method: 'POST',
  });
  return response.data;
}

/**
 * Fetch the versioned deep-research report generated for a completed run.
 * The DeepReportPage renders this structured, versioned LLM output.
 * @param runId - Run primary key.
 * @returns The deep-report payload.
 */
export async function getDeepReport(runId: string) {
  const response = await http({
    url: `/api/multi-agent/deep-report/${runId}`,
    method: 'GET',
  });
  return response.data;
}

/**
 * Generate a sample/mock deep report for a run (used for demos and UI testing).
 * @param runId - Run primary key.
 * @returns The generated sample report.
 */
export async function generateSampleDeepReport(runId: string) {
  const response = await http({
    url: `/api/multi-agent/runs/${runId}/generate-sample-deep-report`,
    method: 'POST',
  });
  return response.data;
}

/**
 * Search stocks by ticker or name (autocomplete source).
 * @param q - Free-text query; empty/whitespace returns no results immediately.
 * @returns The `items` array of matching instruments, or `[]` on an empty query.
 */
export async function searchStocks(q: string) {
  if (!q || !q.trim()) return [];
  const response = await http({
    url: `/api/quote/search?q=${encodeURIComponent(q.trim())}`,
    method: 'GET',
  });
  const data = response.data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/**
 * Fetch the aggregated portfolio context injected into agent prompts
 * (current holdings, cash, recent trades, risk exposure).
 * @returns The portfolio-context payload.
 */
export async function getPortfolioContext() {
  const response = await http({
    url: '/api/multi-agent/portfolio-context',
    method: 'GET',
  });
  return response.data;
}

export { logger };

/**
 * Auth: first-party account system (server/modules/auth).
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

/**
 * Log in with username + password; returns the issued JWT session.
 */
export async function apiLogin(dto: LoginDto): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/login', method: 'POST', data: dto });
  return response.data;
}

/**
 * Create an account and return the issued JWT session.
 */
export async function apiRegister(dto: RegisterDto): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/register', method: 'POST', data: dto });
  return response.data;
}

export async function fetchRegistrationStatus(): Promise<RegistrationStatus> {
  const response = await http({ url: '/api/auth/registration-status', method: 'GET' });
  return response.data;
}

export async function apiRecoverAccount(dto: { username: string; recoveryCode: string; newPassword: string }): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/recover', method: 'POST', data: dto });
  return response.data;
}

export async function apiRotateRecoveryCode(password: string): Promise<AuthTokens> {
  const response = await http({ url: '/api/auth/recovery-code', method: 'POST', data: { password } });
  return response.data;
}

/**
 * Profile of the caller (layout user menu).
 */
export async function fetchMyProfile(): Promise<AuthProfile> {
  const response = await http({ url: '/api/auth/me', method: 'GET' });
  return response.data;
}

/**
 * Paper trading: full overview for the paper page.
 */
export async function fetchPaperOverview(): Promise<PaperOverview> {
  const response = await http({ url: '/api/paper/overview', method: 'GET' });
  return response.data;
}

/**
 * Paper trading: place a manual (market) order.
 */
export async function placePaperOrder(dto: CreatePaperOrderDto): Promise<PaperOrder> {
  const response = await http({ url: '/api/paper/orders', method: 'POST', data: dto });
  return response.data;
}

/**
 * Paper trading: enable/disable the watchbot.
 */
export async function togglePaperBot(enabled: boolean): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/bot/toggle', method: 'POST', data: { enabled } });
  return response.data;
}

/**
 * Paper trading: trigger one bot scan immediately.
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
 * Paper trading: update guardrail thresholds.
 */
export async function updatePaperGuardrails(
  patch: Partial<PaperGuardrails>,
): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/guardrails', method: 'PUT', data: patch });
  return response.data;
}

/**
 * Paper trading: reset the account (drops all paper data).
 */
export async function resetPaperAccount(initialCash?: number): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/account/reset', method: 'POST', data: { initialCash } });
  return response.data;
}

/**
 * Paper trading: mirror the caller's real portfolio into the paper account.
 * Copies every real holding (ticker, shares, cost) and sets cash to zero.
 */
export async function mirrorRealPortfolio(): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/mirror-real', method: 'POST' });
  return response.data;
}

/**
 * Paper trading: lazily create the caller's paper account.
 */
export async function ensurePaperAccount(): Promise<PaperAccount> {
  const response = await http({ url: '/api/paper/account', method: 'POST' });
  return response.data;
}

/**
 * Notifications: list configured channels.
 */
export async function fetchNotificationChannels(): Promise<NotificationChannel[]> {
  const response = await http({ url: '/api/notifications/channels', method: 'GET' });
  return response.data;
}

/**
 * Notifications: add a channel.
 */
export async function createNotificationChannel(
  dto: CreateNotificationChannelDto,
): Promise<NotificationChannel> {
  const response = await http({ url: '/api/notifications/channels', method: 'POST', data: dto });
  return response.data;
}

/**
 * Notifications: enable/disable a channel.
 */
export async function setNotificationChannelEnabled(id: string, enabled: boolean): Promise<void> {
  await http({ url: `/api/notifications/channels/${id}/enabled`, method: 'PUT', data: { enabled } });
}

/**
 * Notifications: remove a channel.
 */
export async function deleteNotificationChannel(id: string): Promise<void> {
  await http({ url: `/api/notifications/channels/${id}`, method: 'DELETE' });
}

/**
 * Notifications: send a test message through one channel.
 */
export async function testNotificationChannel(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const response = await http({ url: `/api/notifications/channels/${id}/test`, method: 'POST' });
  return response.data;
}

/**
 * Import: create holdings from mapped/extracted rows.
 */
export async function commitImport(dto: ImportCommitDto): Promise<ImportCommitResult> {
  const response = await http({ url: '/api/import/commit', method: 'POST', data: dto });
  return response.data;
}

/**
 * Import: extract holdings from a broker screenshot via the user's own
 * multimodal LLM key (transient, server never persists it).
 */
export async function extractScreenshot(
  dto: OcrExtractDto,
): Promise<OcrExtractResult> {
  const response = await http({ url: '/api/import/ocr/extract', method: 'POST', data: dto, timeout: 120000 });
  return response.data;
}

/** Start a transient screenshot job. requestId provides server-side idempotency. */
export async function createScreenshotJob(dto: ScreenshotExtractRequest): Promise<ScreenshotJob> {
  const response = await http({ url: '/api/import/screenshot-jobs', method: 'POST', data: dto });
  return response.data;
}

/** Read-only recovery also works when the initial POST response was lost. */
export async function fetchScreenshotJob(id: string): Promise<ScreenshotJob> {
  const response = await http({ url: `/api/import/screenshot-jobs/${encodeURIComponent(id)}`, method: 'GET' });
  return response.data;
}

export async function cancelScreenshotJob(id: string): Promise<ScreenshotJob> {
  const response = await http({ url: `/api/import/screenshot-jobs/${encodeURIComponent(id)}`, method: 'DELETE' });
  return response.data;
}

/**
 * Import: recent import history.
 */
export async function fetchImportHistory(): Promise<ImportHistoryItem[]> {
  const response = await http({ url: '/api/import/history', method: 'GET' });
  return response.data;
}

/**
 * MCP: list agent sessions.
 */
export async function fetchAgentSessions(): Promise<AgentSession[]> {
  const response = await http({ url: '/api/mcp/sessions', method: 'GET' });
  return response.data;
}

/**
 * MCP: create an agent session (token returned once).
 */
export async function createAgentSession(dto: CreateAgentSessionDto): Promise<AgentSession> {
  const response = await http({ url: '/api/mcp/sessions', method: 'POST', data: dto });
  return response.data;
}

/**
 * MCP: update a session's limits/mode.
 */
export async function updateAgentSession(
  id: string,
  patch: { dailyLimitUsd?: number; permission?: AgentPermission; approvalMode?: AgentApprovalMode },
): Promise<AgentSession> {
  const response = await http({ url: `/api/mcp/sessions/${id}`, method: 'PUT', data: patch });
  return response.data;
}

/**
 * MCP: revoke an agent session.
 */
export async function revokeAgentSession(id: string): Promise<void> {
  await http({ url: `/api/mcp/sessions/${id}/revoke`, method: 'POST' });
}

/**
 * Paper trading: approve a pending agent order.
 */
export async function approvePaperOrder(orderId: string): Promise<PaperOrder> {
  const response = await http({ url: `/api/paper/orders/${orderId}/approve`, method: 'POST' });
  return response.data;
}

/**
 * Paper trading: reject a pending agent order.
 */
export async function rejectPaperOrder(orderId: string): Promise<PaperOrder> {
  const response = await http({ url: `/api/paper/orders/${orderId}/reject`, method: 'POST' });
  return response.data;
}
export * as researchDocuments from './research-documents';
export * as strategyMandates from './strategy-mandates';
export * as simulationExperiments from './simulation-experiments';
