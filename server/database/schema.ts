/* eslint-disable */
/**
 * Drizzle ORM table/column definitions for Squabble.
 *
 * Since the de-platforming this file is the hand-maintained source of truth
 * for the database shape (the platform codegen is gone). The matching DDL for
 * fresh installs lives in scripts/db/01_schema.sql and must be kept in sync.
 *
 * Ownership model: every business row carries an `owner` text column holding
 * the owning users.id; services always scope queries by the authenticated
 * userId (row-level isolation) and stamp owner/_created_by/_updated_by on
 * insert.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

/**
 * Owner column type.
 *
 * Historically the platform stored row ownership in a `user_profile` Postgres
 * composite type. Since the de-platforming the column is a plain `text`
 * holding the owning user id; the exported name is kept so table declarations
 * stay untouched. Pass-through conversion on both directions.
 */
export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'text';
  },
  toDriver(value: string) {
    return value;
  },
  fromDriver(value: string): string {
    return value;
  },
});

/**
 * First-party user accounts (see server/modules/auth). An account is a
 * username plus a bcrypt password hash — no phone number, no email
 * verification; emailNotify is an optional free-text routing hint the user
 * may fill in for notifications and is never validated.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 32 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  recoveryCodeHash: text("recovery_code_hash"),
  sessionVersion: integer("session_version").default(0).notNull(),
  displayName: varchar("display_name", { length: 64 }),
  emailNotify: varchar("email_notify", { length: 255 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const deepReport = pgTable("deep_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().unique(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  analysisTrace: jsonb("analysis_trace"),
  rating: varchar("rating", { length: 20 }),
  confidence: varchar("confidence", { length: 10 }),
  targetBear: numeric("target_bear"),
  targetBase: numeric("target_base"),
  targetBull: numeric("target_bull"),
  probBear: numeric("prob_bear"),
  probBase: numeric("prob_base"),
  probBull: numeric("prob_bull"),
  coreThesis: text("core_thesis"),
  viewChange: text("view_change"),
  prevRating: varchar("prev_rating", { length: 20 }),
  companyOverview: text("company_overview"),
  businessModel: text("business_model"),
  moat: text("moat"),
  revenueStructure: jsonb("revenue_structure"),
  financialAnnual: jsonb("financial_annual"),
  financialQuarterly: jsonb("financial_quarterly"),
  profitability: jsonb("profitability"),
  balanceSheet: jsonb("balance_sheet"),
  cashFlow: jsonb("cash_flow"),
  financialQuality: text("financial_quality"),
  segmentAnalysis: jsonb("segment_analysis"),
  valuationRelative: jsonb("valuation_relative"),
  valuationSotp: jsonb("valuation_sotp"),
  valuationMethodology: text("valuation_methodology"),
  industryOverview: text("industry_overview"),
  marketSize: text("market_size"),
  competitivePosition: text("competitive_position"),
  industryTrends: text("industry_trends"),
  bullPoints: jsonb("bull_points"),
  bearPoints: jsonb("bear_points"),
  criticPoints: jsonb("critic_points"),
  revisedAssumptions: text("revised_assumptions"),
  catalystsTimeline: jsonb("catalysts_timeline"),
  riskItems: jsonb("risk_items"),
  riskGateSnapshot: jsonb("risk_gate_snapshot"),
  pmAction: text("pm_action"),
  pmPriceRange: text("pm_price_range"),
  pmPositionSize: text("pm_position_size"),
  pmStopLoss: text("pm_stop_loss"),
  pmExecutionPlan: text("pm_execution_plan"),
  trackingMetrics: jsonb("tracking_metrics"),
  viewChangeTriggers: text("view_change_triggers"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_deep_report_run").on(table.runId),
  // Complex index: CREATE INDEX idx_deep_report_owner ON deep_report USING btree (((owner).user_id)),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "deep_report_run_id_fkey",
  }).onDelete("cascade"),
]);

export const agentAuditLog = pgTable("agent_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id"),
  action: varchar("action", { length: 50 }).notNull(),
  /**
   * @type {Record<string, any>}
   */
  detail: jsonb("detail"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE INDEX idx_audit_owner_date ON agent_audit_log USING btree (((owner).user_id), _created_at),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "agent_audit_log_run_id_fkey",
  }).onDelete("set null"),
]);

export const strategyRules = pgTable("strategy_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  ruleKey: varchar("rule_key", { length: 50 }).notNull(),
  ruleName: varchar("rule_name", { length: 100 }).notNull(),
  ruleType: varchar("rule_type", { length: 20 }).notNull(),
  threshold: numeric("threshold"),
  unit: varchar("unit", { length: 20 }),
  enabled: boolean("enabled").notNull().default(true),
  description: text("description"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  category: varchar("category", { length: 50 }),
  severity: varchar("severity", { length: 20 }).default('warning'),
  sort: integer("sort").default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE UNIQUE INDEX idx_strategy_rules_owner_key ON strategy_rules USING btree (((owner).user_id), rule_key),
]);

export const riskGateResults = pgTable("risk_gate_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  ruleName: varchar("rule_name", { length: 50 }).notNull(),
  ruleType: varchar("rule_type", { length: 20 }).notNull(),
  passed: boolean("passed").notNull(),
  currentValue: numeric("current_value"),
  thresholdValue: numeric("threshold_value"),
  detail: text("detail"),
  suggestedAction: text("suggested_action"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_risk_gate_run").on(table.runId),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "risk_gate_results_run_id_fkey",
  }).onDelete("cascade"),
]);

export const agentRatings = pgTable("agent_ratings", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  rating: varchar("rating", { length: 20 }).notNull(),
  confidence: varchar("confidence", { length: 10 }).notNull(),
  targetPrice: numeric("target_price"),
  action: text("action").notNull(),
  aggregationLogic: text("aggregation_logic"),
  keyUncertainty: text("key_uncertainty"),
  bullSummary: text("bull_summary"),
  bearSummary: text("bear_summary"),
  catalysts: text("catalysts"),
  risks: text("risks"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE UNIQUE INDEX idx_agent_ratings_owner_run ON agent_ratings USING btree (((owner).user_id), run_id),
  // Complex index: CREATE INDEX idx_agent_ratings_owner_ticker ON agent_ratings USING btree (((owner).user_id), ticker),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "agent_ratings_run_id_fkey",
  }).onDelete("cascade"),
]);

export const debateRecords = pgTable("debate_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  round: integer("round").notNull(),
  speaker: varchar("speaker", { length: 30 }).notNull(),
  content: text("content").notNull(),
  tokensUsed: integer("tokens_used").default(0),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_debate_run").on(table.runId),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "debate_records_run_id_fkey",
  }).onDelete("cascade"),
]);

export const bullBearArguments = pgTable("bull_bear_arguments", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  side: varchar("side", { length: 10 }).notNull(),
  round: integer("round").notNull().default(1),
  argument: text("argument").notNull(),
  /**
   * @type {string[]}
   */
  evidenceIds: jsonb("evidence_ids"),
  counteredBy: uuid("countered_by"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_bull_bear_run").on(table.runId),
  index("idx_bull_bear_run_side").on(table.runId, table.side),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "bull_bear_arguments_run_id_fkey",
  }).onDelete("cascade"),
]);

export const agentEvidence = pgTable("agent_evidence", {
  metadata: jsonb("metadata").$type<import('@shared/research-evidence.interface').EvidenceMetadata>(),
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  role: varchar("role", { length: 30 }).notNull(),
  evidenceType: varchar("evidence_type", { length: 30 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  content: text("content").notNull(),
  sourceUrl: text("source_url"),
  sourceName: varchar("source_name", { length: 100 }),
  fetchedAt: customTimestamptz("fetched_at", { precision: 3 }).notNull(),
  relevanceScore: numeric("relevance_score"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_agent_evidence_run").on(table.runId),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [agentRuns.id],
    name: "agent_evidence_run_id_fkey",
  }).onDelete("cascade"),
]);

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  tickerName: varchar("ticker_name", { length: 100 }),
  market: varchar("market", { length: 10 }),
  triggerType: varchar("trigger_type", { length: 20 }).notNull(),
  runMode: varchar("run_mode", { length: 20 }).notNull().default('full'),
  language: varchar("language", { length: 10 }).notNull().default('zh-CN'),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  modelFast: varchar("model_fast", { length: 50 }),
  modelSlow: varchar("model_slow", { length: 50 }),
  modelRoute: jsonb("model_route"),
  tokensUsed: integer("tokens_used").default(0),
  costEstimate: numeric("cost_estimate").default('0'),
  startedAt: customTimestamptz("started_at", { precision: 3 }),
  completedAt: customTimestamptz("completed_at", { precision: 3 }),
  errorMessage: text("error_message"),
  humanDecision: varchar("human_decision", { length: 20 }),
  humanNote: text("human_note"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE INDEX idx_agent_runs_owner_ticker ON agent_runs USING btree (((owner).user_id), ticker),
  // Complex index: CREATE INDEX idx_agent_runs_owner_status ON agent_runs USING btree (((owner).user_id), status),
  // Complex index: CREATE INDEX idx_agent_runs_owner_date ON agent_runs USING btree (((owner).user_id), _created_at),
]);

export const fxRates = pgTable("fx_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  rateDate: date("rate_date").notNull(),
  base: varchar("base", { length: 10 }).notNull(),
  quote: varchar("quote", { length: 10 }).notNull(),
  rate: numeric("rate").notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_fx_rates_date_base_quote").on(table.rateDate, table.base, table.quote),
]);

export const cashAccounts = pgTable("cash_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  currency: varchar("currency", { length: 10 }).notNull(),
  balance: numeric("balance").notNull().default('0'),
  reconciliationStatus: varchar("reconciliation_status", { length: 20 }).notNull().default('unconfirmed'),
  confirmedAt: customTimestamptz("confirmed_at", { precision: 3 }),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_cash_owner_currency").on(table.owner, table.currency),
]);

export const alphaPicks = pgTable("alpha_picks", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  company: varchar("company", { length: 255 }),
  sector: varchar("sector", { length: 100 }),
  datePicked: date("date_picked"),
  returnPct: numeric("return_pct"),
  rating: varchar("rating", { length: 30 }),
  weightPct: numeric("weight_pct"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_alpha_picks_date").on(table.datePicked),
]);

export const snapshots = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotDate: date("snapshot_date").notNull(),
  accountValue: numeric("account_value"),
  totalMv: numeric("total_mv"),
  cost: numeric("cost"),
  cash: numeric("cash"),
  totalPl: numeric("total_pl"),
  dailyPl: numeric("daily_pl"),
  dailyPct: numeric("daily_pct"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  netDeposit: numeric("net_deposit").default('0'),
  cumulativeNetDeposit: numeric("cumulative_net_deposit").default('0'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_snapshots_owner_date").on(table.owner, table.snapshotDate),
]);

export const journal = pgTable("journal", {
  id: uuid("id").primaryKey().defaultRandom(),
  journalDate: date("journal_date").notNull(),
  marketSummary: text("market_summary"),
  portfolioSummary: text("portfolio_summary"),
  actions: text("actions"),
  plan: text("plan"),
  lessons: text("lessons"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_journal_owner_date").on(table.owner, table.journalDate),
]);

export const closed = pgTable("closed", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  company: varchar("company", { length: 255 }),
  openDate: date("open_date"),
  closeDate: date("close_date"),
  buyPrice: numeric("buy_price"),
  sellPrice: numeric("sell_price"),
  shares: numeric("shares"),
  realizedPl: numeric("realized_pl"),
  returnPct: numeric("return_pct"),
  notes: text("notes"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_closed_close_date").on(table.closeDate),
  index("idx_closed_ticker").on(table.ticker),
]);

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ledgerOrder: bigint("ledger_order", { mode: 'number' }).generatedByDefaultAsIdentity().notNull(),
  txDate: date("tx_date").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  txType: varchar("tx_type", { length: 10 }).notNull(),
  shares: numeric("shares").notNull(),
  price: numeric("price").notNull(),
  fees: numeric("fees").default('0'),
  notes: text("notes"),
  sourceIdentity: text("source_identity"),
  sourceFingerprint: text("source_fingerprint"),
  sourceBatchId: uuid("source_batch_id"),
  sourceData: jsonb("source_data"),
  linkedTransactionId: uuid("linked_transaction_id"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  currency: varchar("currency", { length: 10 }).default('USD'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_transactions_date").on(table.txDate),
  index("idx_transactions_ticker").on(table.ticker),
  uniqueIndex("idx_transactions_owner_source_identity").on(table.owner, table.sourceIdentity),
  uniqueIndex("idx_transactions_owner_source_fingerprint").on(table.owner, table.sourceFingerprint).where(sql`${table.sourceIdentity} IS NULL`),
]);

export const analysis = pgTable("analysis", {
  id: uuid("id").primaryKey().defaultRandom(),
  analysisDate: date("analysis_date").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  rating: varchar("rating", { length: 500 }),
  action: varchar("action", { length: 500 }),
  analysis: text("analysis"),
  targetPrice: numeric("target_price"),
  catalysts: text("catalysts"),
  risks: text("risks"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_analysis_date").on(table.analysisDate),
  uniqueIndex("idx_analysis_owner_date_ticker").on(table.owner, table.analysisDate, table.ticker),
]);

export const watchlist = pgTable("watchlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  company: varchar("company", { length: 255 }),
  sector: varchar("sector", { length: 100 }),
  dateAdded: date("date_added"),
  entryPrice: numeric("entry_price"),
  currentPrice: numeric("current_price"),
  rating: varchar("rating", { length: 30 }),
  signal: varchar("signal", { length: 20 }),
  targetBuy: numeric("target_buy"),
  analysis: text("analysis"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  market: varchar("market", { length: 10 }).default('US'),
  currency: varchar("currency", { length: 10 }).default('USD'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE UNIQUE INDEX idx_watchlist_owner_ticker ON watchlist USING btree (((owner).user_id), ticker),
]);

export const holdings = pgTable("holdings", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  company: varchar("company", { length: 255 }),
  sector: varchar("sector", { length: 255 }),
  buyDate: date("buy_date"),
  buyPrice: numeric("buy_price"),
  shares: numeric("shares").notNull().default('0'),
  currentPrice: numeric("current_price"),
  rating: varchar("rating", { length: 500 }),
  action: varchar("action", { length: 500 }),
  analysis: text("analysis"),
  targetPrice: numeric("target_price"),
  groupId: uuid("group_id"),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  market: varchar("market", { length: 10 }).default('US'),
  currency: varchar("currency", { length: 10 }).default('USD'),
  symbolNative: varchar("symbol_native", { length: 40 }),
  displaySymbol: varchar("display_symbol", { length: 40 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE UNIQUE INDEX idx_holdings_owner_ticker ON holdings USING btree (((owner).user_id), ticker),
  index("idx_holdings_group").on(table.groupId),
  foreignKey({
    columns: [table.groupId],
    foreignColumns: [groups.id],
    name: "holdings_group_id_fkey",
  }).onDelete("set null"),
]);

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  color: varchar("color", { length: 20 }),
  sort: integer("sort").default(0),
  owner: userProfile("owner").notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE UNIQUE INDEX idx_groups_owner_name ON groups USING btree (((owner).user_id), name),
]);

// table aliases
export const agentAuditLogTable = agentAuditLog;
export const agentEvidenceTable = agentEvidence;
export const agentRatingsTable = agentRatings;
export const agentRunsTable = agentRuns;
export const alphaPicksTable = alphaPicks;
export const analysisTable = analysis;
export const bullBearArgumentsTable = bullBearArguments;
export const cashAccountsTable = cashAccounts;
export const closedTable = closed;
export const debateRecordsTable = debateRecords;
export const deepReportTable = deepReport;
export const fxRatesTable = fxRates;
export const groupsTable = groups;
export const holdingsTable = holdings;
export const journalTable = journal;
export const riskGateResultsTable = riskGateResults;
export const snapshotsTable = snapshots;
export const strategyRulesTable = strategyRules;
export const transactionsTable = transactions;
export const watchlistTable = watchlist;

/**
 * Paper trading (AI 模拟盘) — fully isolated from real records. The broker
 * adapter is paper-only by construction: no table here connects to any real
 * brokerage account.
 */

/** One paper account per user; guardrails config lives inline as JSON. */
export const paperAccounts = pgTable("paper_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  name: text("name").default("Paper account").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  ledgerMode: text("ledger_mode").default("legacy_usd").notNull(),
  executionModel: jsonb("execution_model").$type<import('../../shared/simulation-experiment.interface').SimulationSeed['model']>()
    .default(sql`'{"version":"paper-v1","feeBps":0,"slippageBps":0,"corporateActions":"unsupported"}'::jsonb`).notNull(),
  baseCurrency: varchar("base_currency", { length: 10 }).default("USD").notNull(),
  initialCash: numeric("initial_cash").default("1000000").notNull(),
  cashBalance: numeric("cash_balance").default("1000000").notNull(),
  botEnabled: boolean("bot_enabled").default(false).notNull(),
  guardrails: jsonb("guardrails")
    .default(sql`'{"dailyLossLimitPct":3,"maxOrderPct":5,"maxOrdersPerDay":10}'::jsonb`)
    .notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const paperAccountsTable = paperAccounts;

/** Simulated positions keyed by (account, ticker). */
export const paperPositions = pgTable("paper_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  accountId: uuid("account_id").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  market: varchar("market", { length: 10 }).default("US").notNull(),
  currency: varchar("currency", { length: 10 }).default("USD").notNull(),
  company: varchar("company", { length: 255 }),
  shares: numeric("shares").default("0").notNull(),
  avgCost: numeric("avg_cost").default("0").notNull(),
  restrictedShares: numeric("restricted_shares").default("0").notNull(),
  openedAt: customTimestamptz("opened_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const paperPositionsTable = paperPositions;

/** Order lifecycle incl. risk-gate rejections (status='rejected_risk'). */
export const paperOrders = pgTable("paper_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  accountId: uuid("account_id").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  market: varchar("market", { length: 10 }).default("US").notNull(),
  currency: varchar("currency", { length: 10 }).default("USD").notNull(),
  company: varchar("company", { length: 255 }),
  side: varchar("side", { length: 10 }).notNull(),
  orderType: varchar("order_type", { length: 10 }).default("market").notNull(),
  quantity: numeric("quantity").notNull(),
  limitPrice: numeric("limit_price"),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  source: varchar("source", { length: 10 }).default("agent").notNull(),
  reason: text("reason"),
  strategyNote: text("strategy_note"),
  riskCheck: jsonb("risk_check"),
  filledPrice: numeric("filled_price"),
  filledAt: customTimestamptz("filled_at", { precision: 3 }),
  sessionId: uuid("session_id"),
  agentName: varchar("agent_name", { length: 64 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const paperOrdersTable = paperOrders;

/** Fill ledger with realized P&L and post-trade cash. */
export const paperTrades = pgTable("paper_trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  accountId: uuid("account_id").notNull(),
  orderId: uuid("order_id").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  market: varchar("market", { length: 10 }).default("US").notNull(),
  side: varchar("side", { length: 10 }).notNull(),
  quantity: numeric("quantity").notNull(),
  price: numeric("price").notNull(),
  fee: numeric("fee").default("0").notNull(),
  realizedPl: numeric("realized_pl"),
  cashAfter: numeric("cash_after").notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const paperTradesTable = paperTrades;

/** Activity timeline: bot runs, fills, guardrail triggers. */
export const paperEvents = pgTable("paper_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  accountId: uuid("account_id").notNull(),
  eventType: varchar("event_type", { length: 30 }).notNull(),
  detail: jsonb("detail"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const paperEventsTable = paperEvents;

/** Daily equity snapshots powering the paper-account curve. */
export const paperSnapshots = pgTable("paper_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  accountId: uuid("account_id").notNull(),
  snapshotDate: date("snapshot_date").notNull(),
  equity: numeric("equity").notNull(),
  benchmarkEquity: numeric("benchmark_equity"),
  indexBenchmarkEquity: numeric("index_benchmark_equity"),
  valuedAt: customTimestamptz("valued_at", { precision: 3 }),
  cash: numeric("cash").notNull(),
  positionsValue: numeric("positions_value").default("0").notNull(),
  dailyPl: numeric("daily_pl").default("0").notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const paperSnapshotsTable = paperSnapshots;

/**
 * Notification channels (self-hosted push routing). config holds
 * per-channel secrets (bark key, serverchan sendkey, telegram token, smtp
 * credentials, webhook url) — they never leave the user's own database.
 */
export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  channelType: varchar("channel_type", { length: 20 }).notNull(),
  label: varchar("label", { length: 100 }),
  config: jsonb("config").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const notificationChannelsTable = notificationChannels;

/**
 * Portfolio import history: one row per committed import
 * (source: 'csv' | 'robinhood' | 'ocr'), with per-row errors preserved.
 */
export const importLogs = pgTable("import_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  source: varchar("source", { length: 20 }).notNull(),
  filename: varchar("filename", { length: 255 }),
  rowsTotal: integer("rows_total").default(0).notNull(),
  rowsImported: integer("rows_imported").default(0).notNull(),
  errors: jsonb("errors"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const importLogsTable = importLogs;

/**
 * AI agent sessions (Robinhood-style agent access).
 * Each external AI assistant gets its own token, daily spending
 * limit, permission scope and approval mode.
 */
export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  name: varchar("name", { length: 64 }).notNull(),
  token: varchar("token", { length: 128 }).notNull(),
  dailyLimitUsd: numeric("daily_limit_usd").default("500").notNull(),
  permission: varchar("permission", { length: 10 }).default("trade").notNull(),
  approvalMode: varchar("approval_mode", { length: 20 }).default("require_approval").notNull(),
  status: varchar("status", { length: 10 }).default("active").notNull(),
  lastUsedAt: customTimestamptz("last_used_at", { precision: 3 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export const agentSessionsTable = agentSessions;

/** Owner-scoped lifecycle and persisted result of a portfolio analysis run. */
export const portfolioAnalysisRuns = pgTable("portfolio_analysis_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  route: jsonb("route").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  progress: jsonb("progress").notNull(),
  report: jsonb("report"),
  usageKnown: boolean("usage_known").default(false).notNull(),
  tokensUsed: integer("tokens_used"),
  errorMessage: text("error_message"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  startedAt: customTimestamptz("started_at", { precision: 3 }),
  completedAt: customTimestamptz("completed_at", { precision: 3 }),
}, (table) => [
  check("portfolio_analysis_runs_status_check", sql`${table.status} IN ('pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled')`),
  index("idx_portfolio_analysis_runs_owner_created").on(table.owner, table.createdAt),
  index("idx_portfolio_analysis_runs_owner_status").on(table.owner, table.status),
  uniqueIndex("idx_portfolio_analysis_runs_one_active_owner").on(table.owner)
    .where(sql`${table.status} IN ('pending', 'running', 'cancelling')`),
]);
export const portfolioAnalysisRunsTable = portfolioAnalysisRuns;

/** User-configured execution profile; active profiles are scoped to an account. */
export const builderProfiles = pgTable("builder_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  accountId: uuid("account_id"),
  config: jsonb("config").notNull(),
  status: varchar("status", { length: 12 }).default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [index("idx_builder_profiles_owner").on(table.owner)]);

/** A paper signal plus the investor's independently recorded real outcome. */
export const builderProposals = pgTable("builder_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: userProfile("owner").notNull(),
  profileId: uuid("profile_id").notNull(),
  profileVersion: integer("profile_version").notNull(),
  signalDate: date("signal_date").notNull(),
  ticker: varchar("ticker", { length: 20 }).notNull(),
  market: varchar("market", { length: 10 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull(),
  side: varchar("side", { length: 10 }).notNull(),
  quantity: numeric("quantity").notNull(),
  referencePrice: numeric("reference_price").notNull(),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 12 }).default("pending").notNull(),
  paperOrderId: uuid("paper_order_id"),
  executedAt: customTimestamptz("executed_at", { precision: 3 }),
  executedQuantity: numeric("executed_quantity"),
  executedPrice: numeric("executed_price"),
  executedFees: numeric("executed_fees"),
  notes: text("notes"),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_builder_proposal_daily").on(table.profileId, table.signalDate, table.ticker, table.side),
  index("idx_builder_proposals_owner_created").on(table.owner, table.createdAt),
]);

/** Encrypted user-owned integration keys; never selected by public endpoints. */
export const userApiSettings = pgTable("user_api_settings", {
  owner: userProfile("owner").primaryKey(),
  llmBaseUrl: text("llm_base_url"),
  llmFastModel: varchar("llm_fast_model", { length: 120 }),
  llmSlowModel: varchar("llm_slow_model", { length: 120 }),
  llmApiKeyEnc: text("llm_api_key_enc"),
  llmRoute: jsonb("llm_route"),
  finnhubApiKeyEnc: text("finnhub_api_key_enc"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export * from './research-memory.schema';
export * from './research-workflow.schema';
export * from './simple-experience.schema';
export * from './investment-policy.schema';
export * from './portfolio-workspace.schema';
export * from './simple-council.schema';
export * from './import-batches.schema';
export * from './research-analysis-requests.schema';

export * from './user-investment-strategies.schema';
export * from './portfolio-value-points.schema';
export * from './user-strategy-runtime.schema';
export * from './strategy-interviews.schema';
export * from './portfolio-history.schema';
export * from './research-deletions.schema';
export * from './data-library.schema';
