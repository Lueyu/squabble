/**
 * Shared API contracts — TypeScript types used by both the NestJS server and
 * the React client. Kept in the `shared/` directory so both sides import the
 * same definitions (no duplication, no drift).
 *
 * Sections:
 *  - Domain enums: Rating, Action, Signal, Market, Currency, TxType.
 *  - Core entities: Holding, WatchItem, Analysis, Transaction, ClosedPosition,
 *    JournalEntry, Snapshot, AlphaPick, CashAccount, FxRate.
 *  - Dashboard / search types: DashboardOverview, GroupSummary, QuoteResponse,
 *    StockSearchResult, AgentStateResponse, ReconcileResult.
 *  - DTOs: Create/Update request bodies for each entity.
 *  - Multi-agent pipeline types: AgentRun*, Evidence, BullBearArgument,
 *    DebateRecord, AgentRating, RiskGateResult, StrategyRule, DeepReport and
 *    all its sub-interfaces, HumanDecisionDto, BatchRunRequest/Result,
 *    PortfolioContext, LatestRating, DailyBatchResult.
 *
 * Numeric money/price fields are stored as strings in the DB (numeric type)
 * and surfaced as strings here to avoid float-precision issues on the client.
 */
export type Rating = 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell';
export type Action = '加仓' | '买入' | '持有' | '减仓' | '卖出' | '观望';
export type Signal = '强烈买入' | '买入' | '观望' | '回避';
export type Market = 'US' | 'HK' | 'CN';
export type Currency = 'USD' | 'HKD' | 'CNY';
export type TxType = 'Buy' | 'Sell' | 'Deposit' | 'Withdrawal' | 'Opening';

export interface Group {
  id: string;
  name: string;
  color: string | null;
  sort: number;
}

export interface Holding {
  id: string;
  ticker: string;
  company: string | null;
  sector: string | null;
  buyDate: string | null;
  buyPrice: string | null;
  shares: string;
  currentPrice: string | null;
  rating: string | null;
  action: string | null;
  analysis: string | null;
  targetPrice: string | null;
  groupId: string | null;
  market: Market;
  currency: Currency;
  symbolNative: string | null;
  displaySymbol: string | null;
  updatedAt: string;
}

export interface WatchItem {
  id: string;
  ticker: string;
  company: string | null;
  sector: string | null;
  dateAdded: string | null;
  entryPrice: string | null;
  currentPrice: string | null;
  rating: string | null;
  signal: string | null;
  targetBuy: string | null;
  analysis: string | null;
  market: Market;
  currency: Currency;
  updatedAt: string;
}

export interface Analysis {
  id: string;
  analysisDate: string;
  ticker: string;
  rating: string | null;
  action: string | null;
  analysis: string | null;
  targetPrice: string | null;
  catalysts: string | null;
  risks: string | null;
  createdAt: string;
}

export interface Transaction {
  id: string;
  txDate: string;
  ticker: string;
  txType: TxType;
  shares: string;
  price: string;
  fees: string;
  notes: string | null;
  currency: Currency;
}

export interface ClosedPosition {
  id: string;
  ticker: string;
  company: string | null;
  openDate: string | null;
  closeDate: string | null;
  buyPrice: string | null;
  sellPrice: string | null;
  shares: string | null;
  realizedPl: string | null;
  returnPct: string | null;
  notes: string | null;
}

export interface JournalEntry {
  id: string;
  journalDate: string;
  marketSummary: string | null;
  portfolioSummary: string | null;
  actions: string | null;
  plan: string | null;
  lessons: string | null;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  snapshotDate: string;
  accountValue: string | null;
  totalMv: string | null;
  cost: string | null;
  cash: string | null;
  totalPl: string | null;
  dailyPl: string | null;
  dailyPct: string | null;
  netDeposit: string | null;
  cumulativeNetDeposit: string | null;
}

export interface AlphaPick {
  id: string;
  ticker: string;
  company: string | null;
  sector: string | null;
  datePicked: string | null;
  returnPct: string | null;
  rating: string | null;
  weightPct: string | null;
}

export interface ListResponse<T> {
  items: T[];
}

export interface GroupSummary {
  groupId: string | null;
  groupName: string | null;
  groupColor: string | null;
  count: number;
  marketValue: string;
  cost: string;
  pl: string;
  returnPct: string;
  weight: string;
}

export interface DashboardOverview {
  accountValue: string;
  totalMv: string;
  cost: string;
  cash: string;
  totalPl: string;
  totalPct: string;
  baseCurrency: Currency;
  totalMvByCurrency: Record<string, string>;
  cashByCurrency: Record<string, string>;
  dailyPl: string;
  dailyPct: string;
  groups: GroupSummary[];
}

export interface CreateHoldingDto {
  ticker: string;
  company?: string;
  sector?: string;
  buyDate?: string;
  buyPrice?: number;
  shares: number;
  currentPrice?: number;
  rating?: string;
  action?: string;
  analysis?: string;
  targetPrice?: number;
  groupId?: string;
}

export interface UpdateHoldingDto {
  company?: string;
  sector?: string;
  buyDate?: string;
  buyPrice?: number;
  shares?: number;
  currentPrice?: number;
  rating?: string;
  action?: string;
  analysis?: string;
  targetPrice?: number;
  groupId?: string;
  market?: Market;
  currency?: Currency;
  symbolNative?: string | null;
  displaySymbol?: string | null;
}

export interface CreateWatchItemDto {
  ticker: string;
  company?: string;
  sector?: string;
  dateAdded?: string;
  entryPrice?: number;
  currentPrice?: number;
  rating?: string;
  signal?: string;
  targetBuy?: number;
  analysis?: string;
}

export interface UpdateWatchItemDto {
  company?: string;
  sector?: string;
  entryPrice?: number;
  currentPrice?: number;
  rating?: string;
  signal?: string;
  targetBuy?: number;
  analysis?: string;
}

export interface CreateGroupDto {
  name: string;
  color?: string;
  sort?: number;
}

export interface UpdateGroupDto {
  name?: string;
  color?: string;
  sort?: number;
}

export interface CreateAnalysisDto {
  analysisDate: string;
  ticker: string;
  rating?: string;
  action?: string;
  analysis?: string;
  targetPrice?: number;
  catalysts?: string;
  risks?: string;
}

export interface CreateTransactionDto {
  txDate: string;
  ticker: string;
  txType: TxType;
  shares: number;
  price: number;
  fees?: number;
  notes?: string;
  currency?: string;
}

export interface CreateClosedDto {
  ticker: string;
  company?: string;
  openDate?: string;
  closeDate?: string;
  buyPrice?: number;
  sellPrice?: number;
  shares?: number;
  realizedPl?: number;
  returnPct?: number;
  notes?: string;
}

export interface CreateJournalDto {
  journalDate: string;
  marketSummary?: string;
  portfolioSummary?: string;
  actions?: string;
  plan?: string;
  lessons?: string;
}

export interface CreateSnapshotDto {
  snapshotDate: string;
  accountValue?: number;
  totalMv?: number;
  cost?: number;
  cash?: number;
  totalPl?: number;
  dailyPl?: number;
  dailyPct?: number;
  netDeposit?: number;
  cumulativeNetDeposit?: number;
}

export interface CreateAlphaPickDto {
  ticker: string;
  company?: string;
  sector?: string;
  datePicked?: string;
  returnPct?: number;
  rating?: string;
  weightPct?: number;
}

export interface BatchPriceUpdateDto {
  ticker: string;
  price: number;
}

export interface CashAccount {
  id: string;
  currency: Currency;
  balance: string;
  updatedAt: string;
}

export interface FxRate {
  date: string;
  base: Currency;
  quote: Currency;
  rate: string;
}

export interface QuoteResponse {
  symbol: string;
  companyName?: string;
  price: string;
  change: string;
  changePercent: string;
  open?: string;
  high?: string;
  low?: string;
  volume?: string;
  currency: Currency;
  market: Market;
  timestamp: number;
  delayed?: boolean;
}

export interface StockSearchResult {
  symbol: string;
  companyName: string;
  market: Market;
  currency: Currency;
  source: 'holding' | 'watchlist' | 'external';
}

export interface AgentStateResponse {
  holdings: Holding[];
  watchlist: WatchItem[];
  groups: Group[];
  analysis: Analysis[];
  transactions: Transaction[];
  closed: ClosedPosition[];
  journal: JournalEntry[];
  snapshots: Snapshot[];
  alphaPicks: AlphaPick[];
  cash: string;
  cashAccounts: CashAccount[];
}

export interface ReconcileResult {
  holdingsCount: number;
  closedCount: number;
  processedTxCount: number;
}

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

export type AgentRunTrigger = 'cron' | 'manual' | 'watchlist';

export type AgentRunMode = 'full' | 'summary';
export type AnalysisLanguage = 'zh-CN' | 'en';

export type AgentRating = 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell' | 'Watch';

export type AgentConfidence = 'high' | 'medium' | 'low';

export type EvidenceRole = 'fundamental' | 'news' | 'technical' | 'macro';

export type EvidenceType =
  | 'financial'
  | 'news'
  | 'price'
  | 'indicator'
  | 'rating'
  | 'other';

export type DebateSide = 'bull' | 'bear';

export type DebateSpeaker = 'bull' | 'bear' | 'critic' | 'moderator';

export type RuleType = 'hard' | 'soft';

export type RuleCategory =
  | 'position_concentration'
  | 'stop_loss_take_profit'
  | 'buy_conditions'
  | 'cash_management'
  | 'risk_gate';

export type RuleSeverity = 'warning' | 'hard_block';

export type HumanDecision = 'approved' | 'modified' | 'rejected' | 'pending';

export type AuditAction =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'human_approved'
  | 'human_modified'
  | 'human_rejected'
  | 'rating_applied';

export interface AgentRun {
  id: string;
  ticker: string;
  tickerName: string | null;
  market: string | null;
  triggerType: AgentRunTrigger;
  runMode: AgentRunMode;
  language: AnalysisLanguage;
  status: AgentRunStatus;
  modelFast: string | null;
  modelSlow: string | null;
  tokensUsed: number;
  costEstimate: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  humanDecision: HumanDecision | null;
  humanNote: string | null;
  createdAt: string;
  updatedAt: string;
  targetBear: string | null;
  targetBase: string | null;
  targetBull: string | null;
  confidence: AgentConfidence | null;
}

export interface AgentEvidence {
  id: string;
  runId: string;
  role: EvidenceRole;
  evidenceType: EvidenceType;
  title: string;
  content: string;
  sourceUrl: string | null;
  sourceName: string | null;
  fetchedAt: string;
  relevanceScore: string | null;
  createdAt: string;
}

export interface BullBearArgument {
  id: string;
  runId: string;
  side: DebateSide;
  round: number;
  argument: string;
  evidenceIds: string[];
  counteredBy: string | null;
  createdAt: string;
}

export interface DebateRecord {
  id: string;
  runId: string;
  round: number;
  speaker: DebateSpeaker;
  content: string;
  tokensUsed: number;
  createdAt: string;
}

export interface AgentRatingRecord {
  id: string;
  runId: string;
  ticker: string;
  rating: AgentRating;
  confidence: AgentConfidence;
  targetPrice: string | null;
  action: string;
  aggregationLogic: string | null;
  keyUncertainty: string | null;
  bullSummary: string | null;
  bearSummary: string | null;
  catalysts: string | null;
  risks: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskGateResult {
  id: string;
  runId: string;
  ruleName: string;
  ruleType: RuleType;
  passed: boolean;
  currentValue: string | null;
  thresholdValue: string | null;
  detail: string | null;
  suggestedAction: string | null;
  createdAt: string;
}

export interface StrategyRule {
  id: string;
  ruleKey: string;
  ruleName: string;
  ruleType: RuleType;
  threshold: string | null;
  unit: string | null;
  enabled: boolean;
  description: string | null;
  category: RuleCategory | null;
  severity: RuleSeverity;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAuditLog {
  id: string;
  runId: string | null;
  action: AuditAction;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentRunDetail extends AgentRun {
  evidence: AgentEvidence[];
  arguments: BullBearArgument[];
  debate: DebateRecord[];
  rating: AgentRatingRecord | null;
  riskGate: RiskGateResult[];
}

export interface CreateAgentRunDto {
  ticker: string;
  tickerName?: string;
  market?: string;
  triggerType: AgentRunTrigger;
  runMode?: AgentRunMode;
  language?: AnalysisLanguage;
}

export interface UpdateAgentRunDto {
  status?: AgentRunStatus;
  humanDecision?: HumanDecision;
  humanNote?: string;
}

export interface CreateEvidenceDto {
  role: EvidenceRole;
  evidenceType: EvidenceType;
  title: string;
  content: string;
  sourceUrl?: string;
  sourceName?: string;
  fetchedAt: string;
  relevanceScore?: number;
}

export interface CreateArgumentDto {
  side: DebateSide;
  round?: number;
  argument: string;
  evidenceIds?: string[];
  counteredBy?: string;
}

export interface CreateDebateRecordDto {
  round: number;
  speaker: DebateSpeaker;
  content: string;
  tokensUsed?: number;
}

export interface CreateAgentRatingDto {
  ticker: string;
  rating: AgentRating;
  confidence: AgentConfidence;
  targetPrice?: number;
  action: string;
  aggregationLogic?: string;
  keyUncertainty?: string;
  bullSummary?: string;
  bearSummary?: string;
  catalysts?: string;
  risks?: string;
}

export interface CreateRiskGateDto {
  ruleName: string;
  ruleType: RuleType;
  passed: boolean;
  currentValue?: number;
  thresholdValue?: number;
  detail?: string;
  suggestedAction?: string;
}

export interface UpdateStrategyRuleDto {
  ruleName?: string;
  ruleType?: RuleType;
  threshold?: number;
  unit?: string;
  enabled?: boolean;
  description?: string;
  category?: RuleCategory;
  severity?: RuleSeverity;
  sort?: number;
}

export interface CreateStrategyRuleDto {
  ruleKey: string;
  ruleName: string;
  ruleType: RuleType;
  threshold?: number;
  unit?: string;
  description?: string;
  category?: RuleCategory;
  severity?: RuleSeverity;
  sort?: number;
}

export interface ReorderStrategyRuleDto {
  id: string;
  sort: number;
}

export interface AnalysisTrace {
  language: AnalysisLanguage;
  engine: 'basic' | 'llm';
  provider: string | null;
  model: string | null;
  generatedAt: string;
  steps: Array<{
    id: 'evidence' | 'debate' | 'critique' | 'risk' | 'rating';
    status: 'completed' | 'skipped' | 'partial';
    summary: string;
    evidenceIds: string[];
  }>;
  evidence: AgentEvidence[];
  debate: DebateRecord[];
}

export interface DeepReport {
  id: string;
  runId: string;
  ticker: string;
  analysisTrace?: AnalysisTrace | null;
  rating: AgentRating | null;
  confidence: AgentConfidence | null;
  targetBear: string | null;
  targetBase: string | null;
  targetBull: string | null;
  probBear: string | null;
  probBase: string | null;
  probBull: string | null;
  coreThesis: string | null;
  viewChange: string | null;
  prevRating: string | null;
  companyOverview: string | null;
  businessModel: string | null;
  moat: string | null;
  revenueStructure: RevenueItem[] | null;
  financialAnnual: FinancialPeriod[] | null;
  financialQuarterly: FinancialPeriod[] | null;
  profitability: ProfitabilityMetric[] | null;
  balanceSheet: BalanceSheetItem[] | null;
  cashFlow: CashFlowItem[] | null;
  financialQuality: string | null;
  segmentAnalysis: SegmentItem[] | null;
  valuationRelative: ValuationRelativeItem[] | null;
  valuationSotp: SotpItem[] | null;
  valuationMethodology: string | null;
  industryOverview: string | null;
  marketSize: string | null;
  competitivePosition: string | null;
  industryTrends: string | null;
  bullPoints: BullBearPoint[] | null;
  bearPoints: BullBearPoint[] | null;
  criticPoints: CriticPoint[] | null;
  revisedAssumptions: string | null;
  catalystsTimeline: CatalystItem[] | null;
  riskItems: RiskItem[] | null;
  riskGateSnapshot: RiskGateResult[] | null;
  pmAction: string | null;
  pmPriceRange: string | null;
  pmPositionSize: string | null;
  pmStopLoss: string | null;
  pmExecutionPlan: string | null;
  trackingMetrics: TrackingMetric[] | null;
  viewChangeTriggers: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RevenueItem {
  segment: string;
  revenue: number | string;
  sharePct: number | string;
  yoyPct?: number | string | null;
}

export interface FinancialPeriod {
  period: string;
  revenue?: number | string | null;
  netProfit?: number | string | null;
  revenueYoy?: number | string | null;
  profitYoy?: number | string | null;
}

export interface ProfitabilityMetric {
  metric: string;
  value: number | string;
  ttm?: number | string | null;
  industry?: number | string | null;
}

export interface BalanceSheetItem {
  item: string;
  value: number | string;
  note?: string | null;
}

export interface CashFlowItem {
  item: string;
  value: number | string;
  note?: string | null;
}

export interface SegmentItem {
  name: string;
  revenue?: number | string | null;
  grossMargin?: number | string | null;
  growthPct?: number | string | null;
  outlook?: string | null;
}

export interface ValuationRelativeItem {
  metric: string;
  current: number | string;
  percentile5y?: number | string | null;
  industryAvg?: number | string | null;
  note?: string | null;
}

export interface SotpItem {
  segment: string;
  valuation: number | string;
  method: string;
  multiple?: number | string | null;
}

export interface BullBearPoint {
  id?: string;
  title: string;
  detail: string;
  evidenceIds?: string[];
}

export interface CriticPoint {
  id?: string;
  originalClaim: string;
  critique: string;
  resolved: boolean;
  revision?: string | null;
}

export interface CatalystItem {
  id?: string;
  date: string;
  title: string;
  type: 'earnings' | 'product' | 'policy' | 'industry' | 'other';
  impact: 'positive' | 'negative' | 'neutral';
  detail?: string | null;
}

export interface RiskItem {
  id?: string;
  risk: string;
  probability: 'high' | 'medium' | 'low';
  impact: 'high' | 'medium' | 'low';
  mitigation: string;
}

export interface TrackingMetric {
  metric: string;
  threshold: string;
  direction: 'above' | 'below' | 'cross';
  frequency: string;
}

export interface AgentRunListQuery {
  activeOnly?: boolean;
  ticker?: string;
  status?: AgentRunStatus;
  runMode?: AgentRunMode;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface HumanDecisionDto {
  decision: 'approved' | 'modified' | 'rejected';
  note?: string;
  modifiedRating?: {
    rating: AgentRating;
    confidence: AgentConfidence;
    targetPrice?: number;
    action: string;
    bullSummary?: string;
    bearSummary?: string;
    catalysts?: string;
    risks?: string;
  };
  applyToHoldings?: boolean;
  syncToAnalysis?: boolean;
}

export interface BatchRunRequest {
  language?: AnalysisLanguage;
  scope: 'holdings' | 'watchlist' | 'all' | 'custom';
  tickers?: string[];
  tiered: boolean;
}

export interface BatchRunItem {
  runId: string;
  ticker: string;
  runMode: AgentRunMode;
  status: AgentRunStatus;
}

export interface BatchRunResult {
  created: number;
  queued: number;
  running: number;
  runs: BatchRunItem[];
  errors: Array<{ ticker: string; error: string }>;
}

export interface DeepReportListItem {
  runId: string;
  ticker: string;
  tickerName: string | null;
  rating: string | null;
  confidence: string | null;
  targetBear: string | null;
  targetBase: string | null;
  targetBull: string | null;
  reportDate: string;
  completedAt: string;
  updatedAt: string;
}

export interface RealizedPlItem {
  ticker: string;
  company: string | null;
  realizedPl: string;
  returnPct: string | null;
  totalShares: string;
  closeCount: number;
  lastCloseDate: string;
  currency: string;
}

export interface RealizedPlSummary {
  totalByCurrency: Record<string, string>;
  totalWinners: number;
  totalLosers: number;
  items: RealizedPlItem[];
}

export interface LatestRating {
  ticker: string;
  rating: AgentRating;
  confidence: AgentConfidence;
  targetPrice: string | null;
  action: string;
  runId: string;
  createdAt: string;
  bullSummary: string | null;
  bearSummary: string | null;
}

export interface AgentRunWithRating extends AgentRun {
  hasReport?: boolean;
  rating: AgentRatingRecord | null;
}

export interface DailyBatchResult {
  holdingsRuns: BatchRunItem[];
  watchlistRuns: BatchRunItem[];
  totalCreated: number;
  errors: Array<{ ticker: string; error: string }>;
}

export interface PortfolioContext {
  totalValue: number;
  totalMv: number;
  cash: number;
  cashRatio: number;
  holdings: Array<{
    ticker: string;
    company: string | null;
    sector: string | null;
    market: string;
    currency: string;
    shares: number;
    currentPrice: number;
    costPrice: number | null;
    marketValue: number;
    weightPct: number;
    pnlPct: number | null;
    companyGroup: string;
  }>;
  companyExposures: Record<string, number>;
}

/**
 * Auth: first-party account system (server/modules/auth).
 *
 * Privacy posture: an account is a username + bcrypt password hash. No
 * phone number, no email verification; emailNotify is an optional routing
 * hint for notifications and is never required.
 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
}

export interface AuthProfile extends AuthUser {
  emailNotify: string | null;
}

export interface AuthTokens {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** Generated once during registration or account recovery; save it privately. */
  recoveryCode?: string;
}

export interface RegistrationStatus {
  registrationOpen: boolean;
}

export interface LoginDto {
  username: string;
  password: string;
}

export interface RegisterDto {
  username: string;
  password: string;
  displayName?: string;
}

/**
 * Paper trading (AI 模拟盘) — fully isolated from real records.
 */
export type PaperSide = 'buy' | 'sell';
export type PaperOrderStatus = 'pending' | 'pending_approval' | 'filled' | 'rejected_risk' | 'cancelled' | 'failed';
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

export interface PaperGuardrails {
  /** Stop the bot for the day when equity drops this % from the day start. */
  dailyLossLimitPct: number;
  /** Max notional of a single order as % of equity. */
  maxOrderPct: number;
  /** Max bot orders per day. */
  maxOrdersPerDay: number;
}

export interface PaperAccount {
  id: string;
  baseCurrency: string;
  initialCash: string;
  cashBalance: string;
  botEnabled: boolean;
  guardrails: PaperGuardrails;
  createdAt: string;
}

export interface PaperPosition {
  id: string;
  ticker: string;
  market: Market;
  currency: Currency;
  company: string | null;
  shares: string;
  avgCost: string;
  openedAt: string;
  updatedAt: string;
}

export interface PaperOrder {
  id: string;
  ticker: string;
  market: Market;
  currency: Currency;
  company: string | null;
  side: PaperSide;
  orderType: 'market' | 'limit';
  quantity: string;
  limitPrice: string | null;
  status: PaperOrderStatus;
  source: PaperOrderSource;
  reason: string | null;
  strategyNote: string | null;
  riskCheck: Record<string, unknown> | null;
  filledPrice: string | null;
  filledAt: string | null;
  createdAt: string;
}

export interface PaperTrade {
  id: string;
  orderId: string;
  ticker: string;
  market: Market;
  side: PaperSide;
  quantity: string;
  price: string;
  fee: string;
  realizedPl: string | null;
  cashAfter: string;
  createdAt: string;
}

export interface PaperEvent {
  id: string;
  eventType: PaperEventType;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface PaperSnapshotPoint {
  date: string;
  equity: string;
  cash: string;
  positionsValue: string;
  dailyPl: string;
}

export interface PaperOverview {
  account: PaperAccount;
  positions: Array<PaperPosition & { lastPrice: string | null; marketValue: string | null; unrealizedPl: string | null; unrealizedPct: string | null }>;
  equity: string;
  positionsValue: string;
  todayPl: string | null;
  totalPl: string;
  totalPlPct: string;
  todayOrderCount: number;
  circuitBreakerActive: boolean;
  curve: PaperSnapshotPoint[];
  recentOrders: PaperOrder[];
  recentEvents: PaperEvent[];
}

export interface CreatePaperOrderDto {
  ticker: string;
  side: PaperSide;
  quantity: number;
  orderType?: 'market' | 'limit';
  limitPrice?: number;
  reason?: string;
}

/** One owner may activate one beginner-built paper agent at a time. */
export type BuilderTemplate = 'guard' | 'scout' | 'balanced';
export type BuilderStatus = 'draft' | 'active' | 'paused';
export type BuilderProposalStatus = 'pending' | 'skipped' | 'recorded';

export interface BuilderConfig {
  /** Language for unattended reviews, captured when the investor saves the profile. */
  language?: 'zh-CN' | 'en';
  name: string;
  template: BuilderTemplate;
  /** Empty means all of the user's holdings and watchlist. */
  tickers: string[];
  /** Optional investor-authored triggers; no AI rating is implied. */
  priceRules?: Array<{
    ticker: string;
    buyAtOrBelow?: number;
    sellAtOrAbove?: number;
  }>;
  minimumRating: 'Buy' | 'Strong Buy';
  /** Optional extra instructions for model review; never a hard risk rule. */
  customPrompt: string;
  maxOrderPct: number;
  dailyLossLimitPct: number;
  maxOrdersPerDay: number;
  notifyOnProposal: boolean;
  /** Omitted legacy configurations use basic rules and conservative cadence. */
  council?: import('./council.interface').CouncilConfig;
  cadence?: import('./council.interface').TradingCadence;
  automation?: import('./strategy.interface').StrategyAutomationConfig;
}

export interface BuilderProfile {
  id: string;
  config: BuilderConfig;
  status: BuilderStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BuilderProposal {
  id: string;
  profileId: string;
  profileVersion: number;
  ticker: string;
  market: Market;
  currency: Currency;
  side: PaperSide;
  quantity: string;
  referencePrice: string;
  reason: string;
  status: BuilderProposalStatus;
  paperOrderId: string | null;
  executedAt: string | null;
  executedQuantity: string | null;
  executedPrice: string | null;
  executedFees: string | null;
  notes: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface BuilderPreview {
  scenarios: Array<{
    key: string;
    result: 'paper' | 'wait' | 'block';
    explanation: string;
  }>;
}

export interface RecordBuilderFillDto {
  executedAt: string;
  quantity: number;
  price: number;
  fees: number;
  notes?: string;
}

/** User-owned provider credentials are never returned by the API. */
export interface IntegrationSettings {
  llm: {
    source: 'user' | 'server' | 'builtin';
    /** Basic mode uses public data and deterministic rules, not a language model. */
    engine: 'basic' | 'llm';
    available: boolean;
    baseUrl: string;
    fastModel: string;
    slowModel: string;
    hasApiKey: boolean;
    maskedApiKey?: string;
    /** Saved credential is unreadable after a host encryption-key change. */
    needsReentry?: boolean;
  };
  financial: {
    source: 'user' | 'builtin';
    provider: 'finnhub' | 'public';
    available: boolean;
    hasApiKey: boolean;
    maskedApiKey?: string;
    needsReentry?: boolean;
  };
}

export interface UpdateLlmIntegrationRequest {
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  /** Omit or send an empty string to retain a previously saved key. */
  apiKey?: string;
}

export interface UpdateFinancialIntegrationRequest {
  provider: 'finnhub';
  /** Omit or send an empty string to retain a previously saved key. */
  apiKey?: string;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
  code?: 'basic_ready' | 'public_ready' | 'public_unavailable' | 'credential_unreadable';
}

/**
 * Notification channels (self-hosted push routing).
 */
export type NotificationChannelType = 'webhook' | 'bark' | 'serverchan' | 'smtp' | 'telegram';

export interface NotificationChannel {
  id: string;
  channelType: NotificationChannelType;
  label: string | null;
  config: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationChannelDto {
  channelType: NotificationChannelType;
  label?: string;
  config: Record<string, string>;
  enabled?: boolean;
}

/**
 * Portfolio import (CSV / Robinhood CSV / screenshot OCR).
 */
export type ImportSource = 'csv' | 'robinhood' | 'ocr';

export interface ImportRowCandidate {
  ticker: string;
  company?: string | null;
  shares: number | string;
  avgCost?: number | string | null;
  currentPrice?: number | string | null;
  currency?: string | null;
}

export interface ImportCommitDto {
  source: ImportSource;
  rows: ImportRowCandidate[];
  filename?: string;
  buyDate?: string;
}

export interface ImportCommitResult {
  logId: string;
  created: number;
  skipped: number;
  failed: Array<{ ticker: string; reason: string }>;
}

export interface ImportHistoryItem {
  id: string;
  source: ImportSource;
  filename: string | null;
  rowsTotal: number;
  rowsImported: number;
  errors: Array<{ ticker: string; reason: string }>;
  createdAt: string;
}

export interface OcrExtractDto {
  imageBase64: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface OcrExtractResult {
  broker: string | null;
  rows: ImportRowCandidate[];
}

/**
 * AI agent sessions (Robinhood-style agent access via MCP).
 */
export type AgentPermission = 'read' | 'trade';
export type AgentApprovalMode = 'auto' | 'require_approval';

export interface AgentSession {
  id: string;
  name: string;
  dailyLimitUsd: string;
  permission: AgentPermission;
  approvalMode: AgentApprovalMode;
  status: 'active' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
  /** Only populated on creation; never returned afterwards. */
  token?: string;
}

export interface CreateAgentSessionDto {
  name: string;
  dailyLimitUsd?: number;
  permission?: AgentPermission;
  approvalMode?: AgentApprovalMode;
}

/** Extended paper order status for the approval flow. */
export type PaperOrderStatusWithApproval = PaperOrderStatus | 'pending_approval';

export interface AgentOrderInfo {
  sessionId: string | null;
  agentName: string | null;
}

/** Public index quotes, kept separate from a user's holdings and quote settings. */
export interface MarketIndexQuote {
  id: string;
  market: Market;
  value: number | null;
  change: number | null;
  changePercent: number | null;
  /** Provider-local time, paired with timeZone (never the HTTP retrieval time). */
  quoteTime: string | null;
  sessionDate: string | null;
  timeZone: string;
  retrievedAt: string | null;
  source: 'Tencent';
  status: 'available' | 'stale' | 'unavailable';
  issue: 'fetch_failed' | 'invalid_quote' | 'outdated_quote' | null;
}

/** An explicitly labelled price-based estimate, not an official fear/greed index. */
export interface MarketMood {
  market: Market;
  score: number | null;
  averageChangePercent: number | null;
  sessionDate: string | null;
  covered: number;
  total: number;
  method: 'index_daily_change_v1';
}

export interface MarketOverviewResponse {
  checkedAt: string;
  refreshAfterSeconds: number;
  indices: MarketIndexQuote[];
  moods: MarketMood[];
}
