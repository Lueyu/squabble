-- 01_schema.sql
-- 吵股 Squabble — database schema for fresh installs (public schema).
--
-- Source of truth: server/database/schema.ts must stay in sync with this file.
-- Ownership model: every business row carries `owner` (text) holding the
-- owning users.id; services scope all queries by the authenticated userId.
-- Applied automatically on the first `docker compose up` (postgres entrypoint).

CREATE TABLE "agent_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"action" varchar(50) NOT NULL,
	"detail" jsonb,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text
);

CREATE TABLE "agent_evidence" (
  "metadata" jsonb,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"role" varchar(30) NOT NULL,
	"evidence_type" varchar(30) NOT NULL,
	"title" varchar(200) NOT NULL,
	"content" text NOT NULL,
	"source_url" text,
	"source_name" varchar(100),
	"fetched_at" timestamptz (3) NOT NULL,
	"relevance_score" numeric,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text
);

CREATE TABLE "agent_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"rating" varchar(20) NOT NULL,
	"confidence" varchar(10) NOT NULL,
	"target_price" numeric,
	"action" text NOT NULL,
	"aggregation_logic" text,
	"key_uncertainty" text,
	"bull_summary" text,
	"bear_summary" text,
	"catalysts" text,
	"risks" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"ticker_name" varchar(100),
	"market" varchar(10),
	"trigger_type" varchar(20) NOT NULL,
	"run_mode" varchar(20) DEFAULT 'full' NOT NULL,
	"language" varchar(10) DEFAULT 'zh-CN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"model_fast" varchar(50),
	"model_slow" varchar(50),
	"model_route" jsonb,
	"tokens_used" integer DEFAULT 0,
	"cost_estimate" numeric DEFAULT '0',
	"started_at" timestamptz (3),
	"completed_at" timestamptz (3),
	"error_message" text,
	"human_decision" varchar(20),
	"human_note" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "alpha_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"company" varchar(255),
	"sector" varchar(100),
	"date_picked" date,
	"return_pct" numeric,
	"rating" varchar(30),
	"weight_pct" numeric,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_date" date NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"rating" varchar(500),
	"action" varchar(500),
	"analysis" text,
	"target_price" numeric,
	"catalysts" text,
	"risks" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "bull_bear_arguments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"side" varchar(10) NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"argument" text NOT NULL,
	"evidence_ids" jsonb,
	"countered_by" uuid,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text
);

CREATE TABLE "cash_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" varchar(10) NOT NULL,
	"balance" numeric DEFAULT '0' NOT NULL,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "closed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"company" varchar(255),
	"open_date" date,
	"close_date" date,
	"buy_price" numeric,
	"sell_price" numeric,
	"shares" numeric,
	"realized_pl" numeric,
	"return_pct" numeric,
	"notes" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "debate_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"speaker" varchar(30) NOT NULL,
	"content" text NOT NULL,
	"tokens_used" integer DEFAULT 0,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text
);

CREATE TABLE "deep_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"analysis_trace" jsonb,
	"rating" varchar(20),
	"confidence" varchar(10),
	"target_bear" numeric,
	"target_base" numeric,
	"target_bull" numeric,
	"prob_bear" numeric,
	"prob_base" numeric,
	"prob_bull" numeric,
	"core_thesis" text,
	"view_change" text,
	"prev_rating" varchar(20),
	"company_overview" text,
	"business_model" text,
	"moat" text,
	"revenue_structure" jsonb,
	"financial_annual" jsonb,
	"financial_quarterly" jsonb,
	"profitability" jsonb,
	"balance_sheet" jsonb,
	"cash_flow" jsonb,
	"financial_quality" text,
	"segment_analysis" jsonb,
	"valuation_relative" jsonb,
	"valuation_sotp" jsonb,
	"valuation_methodology" text,
	"industry_overview" text,
	"market_size" text,
	"competitive_position" text,
	"industry_trends" text,
	"bull_points" jsonb,
	"bear_points" jsonb,
	"critic_points" jsonb,
	"revised_assumptions" text,
	"catalysts_timeline" jsonb,
	"risk_items" jsonb,
	"risk_gate_snapshot" jsonb,
	"pm_action" text,
	"pm_price_range" text,
	"pm_position_size" text,
	"pm_stop_loss" text,
	"pm_execution_plan" text,
	"tracking_metrics" jsonb,
	"view_change_triggers" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text,
	CONSTRAINT "deep_report_run_id_unique" UNIQUE("run_id")
);

CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_date" date NOT NULL,
	"base" varchar(10) NOT NULL,
	"quote" varchar(10) NOT NULL,
	"rate" numeric NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(20),
	"sort" integer DEFAULT 0,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"company" varchar(255),
	"sector" varchar(255),
	"buy_date" date,
	"buy_price" numeric,
	"shares" numeric DEFAULT '0' NOT NULL,
	"current_price" numeric,
	"rating" varchar(500),
	"action" varchar(500),
	"analysis" text,
	"target_price" numeric,
	"group_id" uuid,
	"owner" text NOT NULL,
	"market" varchar(10) DEFAULT 'US',
	"currency" varchar(10) DEFAULT 'USD',
	"symbol_native" varchar(40),
	"display_symbol" varchar(40),
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_date" date NOT NULL,
	"market_summary" text,
	"portfolio_summary" text,
	"actions" text,
	"plan" text,
	"lessons" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "risk_gate_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"rule_name" varchar(50) NOT NULL,
	"rule_type" varchar(20) NOT NULL,
	"passed" boolean NOT NULL,
	"current_value" numeric,
	"threshold_value" numeric,
	"detail" text,
	"suggested_action" text,
	"owner" text NOT NULL,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text
);

CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_date" date NOT NULL,
	"account_value" numeric,
	"total_mv" numeric,
	"cost" numeric,
	"cash" numeric,
	"total_pl" numeric,
	"daily_pl" numeric,
	"daily_pct" numeric,
	"owner" text NOT NULL,
	"net_deposit" numeric DEFAULT '0',
	"cumulative_net_deposit" numeric DEFAULT '0',
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "strategy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_key" varchar(50) NOT NULL,
	"rule_name" varchar(100) NOT NULL,
	"rule_type" varchar(20) NOT NULL,
	"threshold" numeric,
	"unit" varchar(20),
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"owner" text NOT NULL,
	"category" varchar(50),
	"severity" varchar(20) DEFAULT 'warning',
	"sort" integer DEFAULT 0,
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_date" date NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"tx_type" varchar(10) NOT NULL,
	"shares" numeric NOT NULL,
	"price" numeric NOT NULL,
	"fees" numeric DEFAULT '0',
	"notes" text,
	"owner" text NOT NULL,
	"currency" varchar(10) DEFAULT 'USD',
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

CREATE TABLE "watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"company" varchar(255),
	"sector" varchar(100),
	"date_added" date,
	"entry_price" numeric,
	"current_price" numeric,
	"rating" varchar(30),
	"signal" varchar(20),
	"target_buy" numeric,
	"analysis" text,
	"owner" text NOT NULL,
	"market" varchar(10) DEFAULT 'US',
	"currency" varchar(10) DEFAULT 'USD',
	"_created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_created_by" text,
	"_updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"_updated_by" text
);

ALTER TABLE "agent_audit_log" ADD CONSTRAINT "agent_audit_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "agent_evidence" ADD CONSTRAINT "agent_evidence_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "agent_ratings" ADD CONSTRAINT "agent_ratings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "bull_bear_arguments" ADD CONSTRAINT "bull_bear_arguments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "debate_records" ADD CONSTRAINT "debate_records_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "deep_report" ADD CONSTRAINT "deep_report_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "risk_gate_results" ADD CONSTRAINT "risk_gate_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "idx_agent_evidence_run" ON "agent_evidence" USING btree ("run_id");
CREATE INDEX "idx_alpha_picks_date" ON "alpha_picks" USING btree ("date_picked");
CREATE INDEX "idx_analysis_date" ON "analysis" USING btree ("analysis_date");
CREATE UNIQUE INDEX "idx_analysis_owner_date_ticker" ON "analysis" USING btree ("owner","analysis_date","ticker");
CREATE INDEX "idx_bull_bear_run" ON "bull_bear_arguments" USING btree ("run_id");
CREATE INDEX "idx_bull_bear_run_side" ON "bull_bear_arguments" USING btree ("run_id","side");
CREATE INDEX "idx_closed_close_date" ON "closed" USING btree ("close_date");
CREATE INDEX "idx_closed_ticker" ON "closed" USING btree ("ticker");
CREATE INDEX "idx_debate_run" ON "debate_records" USING btree ("run_id");
CREATE UNIQUE INDEX "idx_deep_report_run" ON "deep_report" USING btree ("run_id");
CREATE UNIQUE INDEX "idx_fx_rates_date_base_quote" ON "fx_rates" USING btree ("rate_date","base","quote");
CREATE INDEX "idx_holdings_group" ON "holdings" USING btree ("group_id");
CREATE UNIQUE INDEX "idx_journal_owner_date" ON "journal" USING btree ("owner","journal_date");
CREATE INDEX "idx_risk_gate_run" ON "risk_gate_results" USING btree ("run_id");
CREATE UNIQUE INDEX "idx_snapshots_owner_date" ON "snapshots" USING btree ("owner","snapshot_date");
CREATE INDEX "idx_transactions_date" ON "transactions" USING btree ("tx_date");
CREATE INDEX "idx_transactions_ticker" ON "transactions" USING btree ("ticker");
-- ============================================================
-- User accounts (first-party auth, see server/modules/auth).
-- An account is a username + bcrypt password hash. No phone, no email
-- verification; email_notify is an optional routing hint, never required.
-- ============================================================
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(32) NOT NULL,
	"password_hash" text NOT NULL,
	"recovery_code_hash" text,
	"session_version" integer DEFAULT 0 NOT NULL,
	"display_name" varchar(64),
	"email_notify" varchar(255),
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);


-- ============================================================
-- Paper trading (AI 模拟盘) — fully isolated from real records.
-- The broker adapter is paper-only by construction: no table here
-- connects to any real brokerage.
-- ============================================================
CREATE TABLE "paper_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"base_currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"initial_cash" numeric DEFAULT '1000000' NOT NULL,
	"cash_balance" numeric DEFAULT '1000000' NOT NULL,
	"bot_enabled" boolean DEFAULT false NOT NULL,
	"guardrails" jsonb DEFAULT '{"dailyLossLimitPct":3,"maxOrderPct":5,"maxOrdersPerDay":10}' NOT NULL,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "paper_accounts_owner_unique" UNIQUE("owner")
);

CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"account_id" uuid NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"market" varchar(10) DEFAULT 'US' NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"company" varchar(255),
	"shares" numeric DEFAULT '0' NOT NULL,
	"avg_cost" numeric DEFAULT '0' NOT NULL,
	"opened_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX "idx_paper_positions_account_ticker" ON "paper_positions" USING btree ("account_id","ticker");

CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"account_id" uuid NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"market" varchar(10) DEFAULT 'US' NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"company" varchar(255),
	"side" varchar(10) NOT NULL,
	"order_type" varchar(10) DEFAULT 'market' NOT NULL,
	"quantity" numeric NOT NULL,
	"limit_price" numeric,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"source" varchar(10) DEFAULT 'agent' NOT NULL,
	"reason" text,
	"strategy_note" text,
	"risk_check" jsonb,
	"filled_price" numeric,
	"filled_at" timestamptz (3),
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "idx_paper_orders_account_created" ON "paper_orders" USING btree ("account_id","created_at");
CREATE INDEX "idx_paper_orders_owner_status" ON "paper_orders" USING btree ("owner","status");

CREATE TABLE "paper_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"ticker" varchar(20) NOT NULL,
	"market" varchar(10) DEFAULT 'US' NOT NULL,
	"side" varchar(10) NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"fee" numeric DEFAULT '0' NOT NULL,
	"realized_pl" numeric,
	"cash_after" numeric NOT NULL,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "idx_paper_trades_account_created" ON "paper_trades" USING btree ("account_id","created_at");
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "paper_orders"("id") ON DELETE cascade ON UPDATE no action;

CREATE TABLE "paper_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"account_id" uuid NOT NULL,
	"event_type" varchar(30) NOT NULL,
	"detail" jsonb,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "idx_paper_events_account_created" ON "paper_events" USING btree ("account_id","created_at");

CREATE TABLE "paper_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"account_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"equity" numeric NOT NULL,
	"cash" numeric NOT NULL,
	"positions_value" numeric DEFAULT '0' NOT NULL,
	"daily_pl" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX "idx_paper_snapshots_account_date" ON "paper_snapshots" USING btree ("account_id","snapshot_date");

-- ============================================================
-- Notification channels (self-hosted push routing).
-- config holds per-channel secrets (bark key, serverchan sendkey,
-- telegram token, smtp credentials, webhook url) — they never
-- leave the user's own database (see docs/privacy.md).
-- ============================================================
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"channel_type" varchar(20) NOT NULL,
	"label" varchar(100),
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "idx_notification_channels_owner" ON "notification_channels" USING btree ("owner");


-- ============================================================
-- Portfolio import history (CSV / Robinhood CSV / screenshot OCR).
-- ============================================================
CREATE TABLE "import_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"source" varchar(20) NOT NULL,
	"filename" varchar(255),
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "idx_import_logs_owner_created" ON "import_logs" USING btree ("owner","created_at");


-- ============================================================
-- AI agent sessions (Robinhood-style agent access).
-- Each external AI assistant (Claude, ChatGPT, etc.) gets its own
-- session with a token, daily spending limit, permission scope
-- and approval mode. Tokens are stored in the user's own database.
-- ============================================================
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"token" varchar(128) NOT NULL,
	"daily_limit_usd" numeric DEFAULT '500' NOT NULL,
	"permission" varchar(10) DEFAULT 'trade' NOT NULL,
	"approval_mode" varchar(20) DEFAULT 'require_approval' NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"last_used_at" timestamptz (3),
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX "idx_agent_sessions_token" ON "agent_sessions" USING btree ("token");
CREATE INDEX "idx_agent_sessions_owner" ON "agent_sessions" USING btree ("owner");

-- Extend paper_orders with agent attribution and approval flow.
ALTER TABLE "paper_orders" ADD COLUMN IF NOT EXISTS "session_id" uuid;
ALTER TABLE "paper_orders" ADD COLUMN IF NOT EXISTS "agent_name" varchar(64);

-- Persisted owner-scoped portfolio analysis runs.
CREATE TABLE "portfolio_analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"route" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"progress" jsonb NOT NULL,
	"report" jsonb,
	"usage_known" boolean DEFAULT false NOT NULL,
	"tokens_used" integer,
	"error_message" text,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"started_at" timestamptz (3),
	"completed_at" timestamptz (3),
	CONSTRAINT "portfolio_analysis_runs_status_check" CHECK ("status" IN ('pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX "idx_portfolio_analysis_runs_owner_created" ON "portfolio_analysis_runs" USING btree ("owner","created_at");
CREATE INDEX "idx_portfolio_analysis_runs_owner_status" ON "portfolio_analysis_runs" USING btree ("owner","status");
CREATE UNIQUE INDEX "idx_portfolio_analysis_runs_one_active_owner" ON "portfolio_analysis_runs" USING btree ("owner") WHERE "status" IN ('pending', 'running', 'cancelling');
CREATE TABLE IF NOT EXISTS research_archive_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  report_id uuid NOT NULL, session_id uuid NOT NULL, report_version integer NOT NULL,
  ticker varchar(20) NOT NULL, topic varchar(120) NOT NULL,
  intent varchar(10) NOT NULL CHECK (intent IN ('automatic','manual')),
  state varchar(10) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), error text,
  lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_archive_jobs_report_idx ON research_archive_jobs(owner, report_id, report_version);
CREATE INDEX IF NOT EXISTS research_archive_jobs_due_idx ON research_archive_jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS research_archive_jobs_owner_idx ON research_archive_jobs(owner, id);
-- Rules are versioned, and breach events are immutable across later observations.
CREATE TABLE IF NOT EXISTS research_monitor_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, root_id uuid NOT NULL,
  thesis_id uuid NOT NULL, thesis_version integer NOT NULL, version integer NOT NULL,
  ticker text NOT NULL, market text NOT NULL, origin text NOT NULL, report_id uuid NOT NULL, report_version integer NOT NULL,
  condition jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_rule_version_idx ON research_monitor_rules(owner, root_id, version);
CREATE INDEX IF NOT EXISTS research_monitor_thesis_idx ON research_monitor_rules(owner, thesis_id, thesis_version);
CREATE TABLE IF NOT EXISTS research_monitor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, rule_id uuid NOT NULL, rule_version integer NOT NULL,
  thesis_id uuid NOT NULL, thesis_version integer NOT NULL, observation_key text NOT NULL, observation jsonb NOT NULL,
  state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sequence integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_observation_idx ON research_monitor_events(owner, rule_id, rule_version, thesis_version, observation_key);
CREATE INDEX IF NOT EXISTS research_monitor_breach_idx ON research_monitor_events(owner, thesis_id, thesis_version, state);
CREATE INDEX IF NOT EXISTS research_monitor_latest_idx ON research_monitor_events(owner, rule_id, sequence DESC, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS research_thesis_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, thesis_id uuid NOT NULL, thesis_version integer NOT NULL,
  previous_id uuid NOT NULL, previous_version integer NOT NULL, reason text NOT NULL,
  cycle_id uuid NOT NULL, task_id uuid NOT NULL, attempt_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_replacement_idx ON research_thesis_replacements(owner, thesis_id, thesis_version);
-- NULL preserves unknown legacy dependency state until a fresh validated plan is captured.
ALTER TABLE IF EXISTS strategy_plans ADD COLUMN IF NOT EXISTS memory_inventory jsonb;


CREATE TABLE IF NOT EXISTS research_memory_preferences (owner text PRIMARY KEY, auto_archive boolean NOT NULL DEFAULT true, recall_enabled boolean NOT NULL DEFAULT true);

-- Consolidated additive schema for fresh installations.
-- Generated by scripts/db/sync-fresh-schema.cjs. Upgrade files remain authoritative.

-- 03_agent_builder.sql
-- Additive migration. Applied on fresh PostgreSQL volumes by initdb and on
-- existing volumes by the database provider before Nest starts serving APIs.
CREATE TABLE IF NOT EXISTS builder_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  config jsonb NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_builder_profiles_owner ON builder_profiles (owner);
CREATE UNIQUE INDEX IF NOT EXISTS idx_builder_profiles_active
  ON builder_profiles (owner) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS builder_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  profile_id uuid NOT NULL REFERENCES builder_profiles(id),
  profile_version integer NOT NULL,
  signal_date date NOT NULL,
  ticker varchar(20) NOT NULL,
  market varchar(10) NOT NULL,
  currency varchar(10) NOT NULL,
  side varchar(10) NOT NULL,
  quantity numeric NOT NULL,
  reference_price numeric NOT NULL,
  reason text NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'pending',
  paper_order_id uuid,
  executed_at timestamptz(3),
  executed_quantity numeric,
  executed_price numeric,
  executed_fees numeric,
  notes text,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_builder_proposal_daily
  ON builder_proposals (profile_id, signal_date, ticker, side);
CREATE INDEX IF NOT EXISTS idx_builder_proposals_owner_created
  ON builder_proposals (owner, created_at);

-- Older installs seeded three rules that cannot be evaluated with the present
-- data model. Pause only untouched built-in copies, exactly once. Users may
-- later choose to enable them again after providing verifiable inputs.
CREATE TABLE IF NOT EXISTS squabble_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
WITH first_apply AS (
  INSERT INTO squabble_migrations (name)
  VALUES ('2026-10-30-pause-unverifiable-default-rules')
  ON CONFLICT DO NOTHING
  RETURNING name
)
UPDATE strategy_rules SET enabled = false
WHERE EXISTS (SELECT 1 FROM first_apply)
  AND enabled = true
  AND (
    (rule_key = 'small_cap_weight' AND description = '市值小于50亿的小盘股总仓位不超过5%')
    OR (rule_key = 'loss_maker_weight' AND description = '最近一期净利润为负的标的合计仓位不超过10%')
    OR (rule_key = 'new_buy_checklist' AND description = '新建仓必须完成：基本面评分、行业地位、估值分位、催化剂、风险点 5 项检查')
  );

-- 04_user_api_settings.sql
CREATE TABLE IF NOT EXISTS user_api_settings (
  owner text PRIMARY KEY,
  llm_base_url text,
  llm_fast_model varchar(120),
  llm_slow_model varchar(120),
  llm_api_key_enc text,
  finnhub_api_key_enc text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 05_analysis_language.sql
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS language varchar(10) NOT NULL DEFAULT 'zh-CN';
ALTER TABLE deep_report ADD COLUMN IF NOT EXISTS analysis_trace jsonb;
ALTER TABLE agent_ratings ALTER COLUMN rating TYPE varchar(20);

-- 06_account_recovery.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;

-- 07_llm_budget.sql
CREATE TABLE IF NOT EXISTS llm_budget_settings (
  owner uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_token_limit integer NOT NULL DEFAULT 60000,
  monthly_token_limit integer NOT NULL DEFAULT 600000,
  per_task_token_limit integer NOT NULL DEFAULT 24000,
  max_input_tokens integer NOT NULL DEFAULT 6000,
  max_output_tokens integer NOT NULL DEFAULT 1000,
  max_calls_per_task integer NOT NULL DEFAULT 8,
  daily_call_limit integer NOT NULL DEFAULT 30,
  input_usd_per_million numeric,
  output_usd_per_million numeric,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT llm_budget_positive_limits CHECK (
    max_input_tokens > 0 AND max_output_tokens > 0
    AND max_calls_per_task > 0 AND max_calls_per_task <= daily_call_limit
    AND max_input_tokens + max_output_tokens <= per_task_token_limit
    AND per_task_token_limit <= daily_token_limit AND daily_token_limit <= monthly_token_limit
    AND monthly_token_limit <= 1000000000 AND max_input_tokens <= 1000000
    AND max_output_tokens <= 1000000 AND max_calls_per_task <= 10000 AND daily_call_limit <= 100000
  ),
  CONSTRAINT llm_budget_nonnegative_rates CHECK (
    (input_usd_per_million IS NULL OR input_usd_per_million BETWEEN 0 AND 100000)
    AND (output_usd_per_million IS NULL OR output_usd_per_million BETWEEN 0 AND 100000)
  )
);

CREATE TABLE IF NOT EXISTS llm_budget_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id varchar(160) NOT NULL,
  purpose varchar(160) NOT NULL,
  model varchar(120) NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  max_output_tokens integer NOT NULL,
  reserved_tokens integer NOT NULL,
  charged_tokens integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at timestamptz,
  CONSTRAINT llm_budget_usage_status CHECK (status IN ('reserved', 'completed', 'estimated', 'failed_unknown')),
  CONSTRAINT llm_budget_usage_nonnegative CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND max_output_tokens > 0
    AND reserved_tokens > 0 AND charged_tokens >= 0
  )
);

CREATE INDEX IF NOT EXISTS llm_budget_usage_owner_date ON llm_budget_usage(owner, created_at);
CREATE INDEX IF NOT EXISTS llm_budget_usage_owner_task ON llm_budget_usage(owner, task_id);

-- 08_investment_council.sql
-- Bounded owner-scoped investment council. Run with ON_ERROR_STOP.
CREATE TABLE IF NOT EXISTS council_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  profile_id uuid NOT NULL REFERENCES builder_profiles(id), profile_version integer NOT NULL CHECK (profile_version > 0),
  profile_snapshot jsonb NOT NULL, ticker varchar(20) NOT NULL,
  language varchar(5) NOT NULL DEFAULT 'zh-CN' CHECK (language IN ('zh-CN','en')),
  status varchar(16) NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','completed','paused','failed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), task_id uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate jsonb, evidence_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb, source_run_id uuid,
  cache_key varchar(64), error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_sessions_owner_created_idx ON council_sessions(owner, created_at);
CREATE INDEX IF NOT EXISTS council_sessions_cache_idx ON council_sessions(owner, cache_key, created_at);
CREATE TABLE IF NOT EXISTS council_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('researcher','challenger','manager','user','system')),
  member_name varchar(40) NOT NULL, content text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  tokens_used integer NOT NULL DEFAULT 0 CHECK (tokens_used >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_messages_session_idx ON council_messages(owner, session_id, created_at);
CREATE TABLE IF NOT EXISTS council_reports (
  publication_outcome varchar(10) CHECK (publication_outcome IN ('succeeded','failed')),
  thesis_candidates JSONB,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0), revision integer NOT NULL CHECK (revision > 0),
  decision varchar(10) NOT NULL CHECK (decision IN ('approve','wait','reject')),
  summary text NOT NULL, dissent jsonb NOT NULL, next_review_condition text NOT NULL,
  evidence jsonb NOT NULL, source_run_id uuid, candidate jsonb, paper_order_id uuid REFERENCES paper_orders(id),
  tokens_used integer NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  engine varchar(10) NOT NULL CHECK (engine IN ('basic','llm')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS council_reports_version_idx ON council_reports(session_id, version);
CREATE INDEX IF NOT EXISTS council_reports_owner_idx ON council_reports(owner, session_id, created_at);

-- 09_builder_cadence.sql
CREATE TABLE IF NOT EXISTS builder_scan_leases (
  owner text PRIMARY KEY,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS builder_review_checks (
  owner text NOT NULL,
  profile_id uuid NOT NULL REFERENCES builder_profiles(id),
  ticker text NOT NULL,
  profile_version integer NOT NULL,
  input_hash text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (owner, profile_id, ticker)
);

-- 10_model_connections.sql
CREATE TABLE IF NOT EXISTS model_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  base_url text NOT NULL,
  fast_model varchar(120) NOT NULL,
  slow_model varchar(120) NOT NULL,
  api_key_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_connections_owner_idx ON model_connections(owner);

-- 11_research_tools.sql
CREATE TABLE IF NOT EXISTS research_tool_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id varchar(160) NOT NULL,
  provider varchar(40) NOT NULL DEFAULT 'deepseek_search',
  status varchar(24) NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at timestamptz,
  CONSTRAINT research_tool_usage_status CHECK (status IN ('reserved', 'succeeded', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS research_tool_usage_owner_date ON research_tool_usage(owner, created_at);
CREATE INDEX IF NOT EXISTS research_tool_usage_owner_task ON research_tool_usage(owner, task_id);

-- 12_council_dialogue.sql
-- Durable research-room turns, existing conversations remain readable.
ALTER TABLE council_sessions ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS checkpoint jsonb;
ALTER TABLE council_messages ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS research_stance varchar(10)
  CHECK (research_stance IS NULL OR research_stance IN ('positive', 'balanced', 'cautious'));

-- 13_budget_toggle.sql
ALTER TABLE llm_budget_settings ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- 14_a2a_agents.sql
ALTER TABLE council_reports DROP CONSTRAINT IF EXISTS council_reports_engine_check;
ALTER TABLE council_reports ADD CONSTRAINT council_reports_engine_check CHECK (engine IN ('basic','llm','a2a','local','mixed'));

-- 15_native_agents.sql
-- Preserve historical A2A reports while new native CLI teams use the local engine.
ALTER TABLE council_reports DROP CONSTRAINT IF EXISTS council_reports_engine_check;
ALTER TABLE council_reports ADD CONSTRAINT council_reports_engine_check
  CHECK (engine IN ('basic', 'llm', 'a2a', 'local', 'mixed'));

-- 16_daily_strategy.sql
CREATE TABLE IF NOT EXISTS strategy_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, profile_id uuid NOT NULL,
 profile_version integer NOT NULL, market text NOT NULL, market_date text NOT NULL,
 attempt integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'claimed', session_ids jsonb NOT NULL DEFAULT '[]',
 reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT strategy_task_unique UNIQUE(owner,profile_id,profile_version,market,market_date,attempt)
);
CREATE TABLE IF NOT EXISTS strategy_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, profile_id uuid NOT NULL,
 profile_version integer NOT NULL, task_id uuid NOT NULL UNIQUE, version integer NOT NULL,
 market text NOT NULL, market_date text NOT NULL, status text NOT NULL DEFAULT 'active',
 rules jsonb NOT NULL, session_ids jsonb NOT NULL, report_ids jsonb NOT NULL, summary text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_plan_active ON strategy_plans(owner,profile_id,market,status);
CREATE TABLE IF NOT EXISTS strategy_signals (
 id uuid PRIMARY KEY, owner text NOT NULL, profile_id uuid NOT NULL, plan_id uuid NOT NULL,
 rule_id text NOT NULL, kind text NOT NULL, state text NOT NULL, candidate jsonb NOT NULL,
 reason text NOT NULL, order_id uuid UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT strategy_signal_unique UNIQUE(plan_id,rule_id,kind)
);
CREATE TABLE IF NOT EXISTS strategy_runtime (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, profile_id uuid NOT NULL,
 profile_version integer NOT NULL, market text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT strategy_runtime_unique UNIQUE(owner,profile_id,market)
);
CREATE TABLE IF NOT EXISTS strategy_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, profile_id uuid NOT NULL,
 event_key text NOT NULL UNIQUE, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 delivered_channel_ids jsonb NOT NULL DEFAULT '[]', available_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_outbox_due ON strategy_outbox(state,available_at);
CREATE TABLE IF NOT EXISTS strategy_protections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL, ticker text NOT NULL,
 market text NOT NULL, stop_loss_price numeric NOT NULL, plan_id uuid NOT NULL, rule_id text NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT strategy_protection_unique UNIQUE(owner,account_id,ticker)
);

ALTER TABLE strategy_plans ADD COLUMN IF NOT EXISTS memory_inventory jsonb;

-- 17_research_memory.sql
-- Additive owner-scoped research memory. Source references contain no evidence-body snapshots.
CREATE TABLE IF NOT EXISTS research_memory_preferences (
  owner text PRIMARY KEY, auto_archive boolean NOT NULL DEFAULT true, recall_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS research_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  ticker varchar(20) NOT NULL, market varchar(2) NOT NULL CHECK (market IN ('US','HK','CN')),
  topic varchar(120) NOT NULL, language varchar(5) NOT NULL CHECK (language IN ('zh-CN','en')),
  session_id uuid NOT NULL, report_id uuid NOT NULL, report_version integer NOT NULL CHECK (report_version > 0),
  report_revision integer NOT NULL CHECK (report_revision > 0), report_created_at timestamptz NOT NULL,
  summary text NOT NULL, decision varchar(10) NOT NULL CHECK (decision IN ('approve','wait','reject')),
  excluded boolean NOT NULL DEFAULT false, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_memories_report_version_idx ON research_memories(owner, report_id, report_version);
CREATE INDEX IF NOT EXISTS research_memories_owner_symbol_idx ON research_memories(owner, market, ticker);
CREATE TABLE IF NOT EXISTS research_theses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  memory_id uuid NOT NULL REFERENCES research_memories(id), content jsonb NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','accepted','confirmed','dismissed','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), excluded boolean NOT NULL DEFAULT false,
  expires_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_theses_owner_memory_idx ON research_theses(owner, memory_id);
CREATE TABLE IF NOT EXISTS research_thesis_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  thesis_id uuid NOT NULL REFERENCES research_theses(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0), content jsonb NOT NULL,
  status varchar(12) NOT NULL CHECK (status IN ('candidate','accepted','confirmed','dismissed','expired')),
  action varchar(12) NOT NULL CHECK (action IN ('candidate','accept','confirm','edit','dismiss','expire','exclude')),
  excluded boolean NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_versions_idx ON research_thesis_versions(owner, thesis_id, version);

-- 18_research_workflow.sql
CREATE TABLE IF NOT EXISTS council_research_tasks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner TEXT NOT NULL,
 session_id UUID NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
 cycle_id UUID NOT NULL, revision INTEGER NOT NULL, key VARCHAR(20) NOT NULL, position INTEGER NOT NULL,
 member_id TEXT NOT NULL, dependencies JSONB NOT NULL, state VARCHAR(20) NOT NULL DEFAULT 'queued', reason TEXT,
 attempts JSONB NOT NULL DEFAULT '[]'::jsonb, delivery JSONB, skills JSONB NOT NULL,
 reworks INTEGER NOT NULL DEFAULT 0, accepted_attempt_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS council_research_tasks_cycle_key_idx ON council_research_tasks(session_id, cycle_id, key);
CREATE INDEX IF NOT EXISTS council_research_tasks_owner_idx ON council_research_tasks(owner, session_id, cycle_id);
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS coverage JSONB;

-- 19_atomic_research_theses.sql
-- Preserve explicit atomic claims. NULL identifies historical reports without structured theses.
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS thesis_candidates JSONB;
-- Workflow acceptance is separate from explicit human confirmation.
ALTER TABLE IF EXISTS research_theses DROP CONSTRAINT IF EXISTS research_theses_status_check;
ALTER TABLE IF EXISTS research_theses ADD CONSTRAINT research_theses_status_check
  CHECK (status IN ('candidate','accepted','confirmed','dismissed','expired'));
ALTER TABLE IF EXISTS research_thesis_versions DROP CONSTRAINT IF EXISTS research_thesis_versions_status_check;
ALTER TABLE IF EXISTS research_thesis_versions ADD CONSTRAINT research_thesis_versions_status_check
  CHECK (status IN ('candidate','accepted','confirmed','dismissed','expired'));
ALTER TABLE IF EXISTS research_thesis_versions DROP CONSTRAINT IF EXISTS research_thesis_versions_action_check;
ALTER TABLE IF EXISTS research_thesis_versions ADD CONSTRAINT research_thesis_versions_action_check
  CHECK (action IN ('candidate','accept','confirm','edit','dismiss','expire','exclude'));

-- 20_research_memory_temporal.sql
-- Additive provenance metadata. Existing values remain unknown and existing opinions are not rewritten.
ALTER TABLE agent_evidence ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE research_thesis_versions ADD COLUMN IF NOT EXISTS change_reason text;
CREATE TABLE IF NOT EXISTS research_memory_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  memory_id uuid NOT NULL REFERENCES research_memories(id),
  report_id uuid NOT NULL REFERENCES council_reports(id) ON DELETE CASCADE,
  report_version integer NOT NULL, report_revision integer NOT NULL, evidence_id text NOT NULL,
  metadata jsonb NOT NULL, ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_memory_evidence_identity_idx
  ON research_memory_evidence(owner, report_id, report_version, report_revision, evidence_id);
CREATE INDEX IF NOT EXISTS research_memory_evidence_memory_idx ON research_memory_evidence(owner, memory_id);
CREATE TABLE IF NOT EXISTS research_thesis_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  version_id uuid NOT NULL REFERENCES research_thesis_versions(id) ON DELETE CASCADE,
  evidence_record_id uuid NOT NULL REFERENCES research_memory_evidence(id) ON DELETE CASCADE,
  role varchar(8) NOT NULL CHECK (role IN ('support','refute','qualify'))
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_evidence_identity_idx
  ON research_thesis_evidence(owner, version_id, evidence_record_id, role);

-- 21_research_archive_jobs.sql
-- Null outcomes are deliberately unknown for historical reports.
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS publication_outcome varchar(10)
  CHECK (publication_outcome IN ('succeeded','failed'));
CREATE TABLE IF NOT EXISTS research_archive_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  report_id uuid NOT NULL, session_id uuid NOT NULL, report_version integer NOT NULL,
  ticker varchar(20) NOT NULL, topic varchar(120) NOT NULL,
  intent varchar(10) NOT NULL CHECK (intent IN ('automatic','manual')),
  state varchar(10) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), error text,
  lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_archive_jobs_report_idx ON research_archive_jobs(owner, report_id, report_version);
CREATE INDEX IF NOT EXISTS research_archive_jobs_due_idx ON research_archive_jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS research_archive_jobs_owner_idx ON research_archive_jobs(owner, id);

-- 22_research_monitors.sql
-- Rules are versioned, and breach events are immutable across later observations.
CREATE TABLE IF NOT EXISTS research_monitor_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, root_id uuid NOT NULL,
  thesis_id uuid NOT NULL, thesis_version integer NOT NULL, version integer NOT NULL,
  ticker text NOT NULL, market text NOT NULL, origin text NOT NULL, report_id uuid NOT NULL, report_version integer NOT NULL,
  condition jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_rule_version_idx ON research_monitor_rules(owner, root_id, version);
CREATE INDEX IF NOT EXISTS research_monitor_thesis_idx ON research_monitor_rules(owner, thesis_id, thesis_version);
CREATE TABLE IF NOT EXISTS research_monitor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, rule_id uuid NOT NULL, rule_version integer NOT NULL,
  thesis_id uuid NOT NULL, thesis_version integer NOT NULL, observation_key text NOT NULL, observation jsonb NOT NULL,
  state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_observation_idx ON research_monitor_events(owner, rule_id, rule_version, thesis_version, observation_key);
CREATE INDEX IF NOT EXISTS research_monitor_breach_idx ON research_monitor_events(owner, thesis_id, thesis_version, state);
CREATE TABLE IF NOT EXISTS research_thesis_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, thesis_id uuid NOT NULL, thesis_version integer NOT NULL,
  previous_id uuid NOT NULL, previous_version integer NOT NULL, reason text NOT NULL,
  cycle_id uuid NOT NULL, task_id uuid NOT NULL, attempt_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_replacement_idx ON research_thesis_replacements(owner, thesis_id, thesis_version);
-- NULL preserves unknown legacy dependency state until a fresh validated plan is captured.
ALTER TABLE IF EXISTS strategy_plans ADD COLUMN IF NOT EXISTS memory_inventory jsonb;

CREATE TABLE IF NOT EXISTS research_memory_preferences (owner text PRIMARY KEY, auto_archive boolean NOT NULL DEFAULT true, recall_enabled boolean NOT NULL DEFAULT true);
ALTER TABLE research_monitor_rules DROP CONSTRAINT IF EXISTS research_monitor_rules_report_fk;
ALTER TABLE research_monitor_rules ADD CONSTRAINT research_monitor_rules_report_fk FOREIGN KEY (report_id) REFERENCES council_reports(id) ON DELETE CASCADE;

-- 23_monitor_observation_order.sql
-- Legacy events retain their content and timestamp ordering at sequence zero.
-- New evaluations advance per rule under the owner transaction fence.
ALTER TABLE IF EXISTS research_monitor_events ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS research_monitor_latest_idx ON research_monitor_events(owner, rule_id, sequence DESC, created_at DESC, id DESC);

-- 24_local_model_route.sql
ALTER TABLE user_api_settings ADD COLUMN IF NOT EXISTS llm_route jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model_route jsonb;

-- 25_portfolio_report.sql
-- Additive, repeatable storage for owner-scoped portfolio analysis runs.
CREATE TABLE IF NOT EXISTS "portfolio_analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"route" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"progress" jsonb NOT NULL,
	"report" jsonb,
	"usage_known" boolean DEFAULT false NOT NULL,
	"tokens_used" integer,
	"error_message" text,
	"created_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamptz (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"started_at" timestamptz (3),
	"completed_at" timestamptz (3),
	CONSTRAINT "portfolio_analysis_runs_status_check" CHECK ("status" IN ('pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS "idx_portfolio_analysis_runs_owner_created" ON "portfolio_analysis_runs" USING btree ("owner","created_at");
CREATE INDEX IF NOT EXISTS "idx_portfolio_analysis_runs_owner_status" ON "portfolio_analysis_runs" USING btree ("owner","status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_portfolio_analysis_runs_one_active_owner" ON "portfolio_analysis_runs" USING btree ("owner") WHERE "status" IN ('pending', 'running', 'cancelling');

-- 26_research_documents.sql
-- Additive, repeatable immutable research artifact storage. Legacy tables stay intact.
CREATE TABLE IF NOT EXISTS research_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, title text NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('daily','deep','portfolio','council')), ticker varchar(30), source_key text,
  parent_report_id uuid REFERENCES research_documents(id), latest_version_id uuid, adopted_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_documents_source_idx ON research_documents(owner, source_key);
CREATE INDEX IF NOT EXISTS research_documents_owner_idx ON research_documents(owner, created_at);
ALTER TABLE research_documents ADD COLUMN IF NOT EXISTS topic_key text NOT NULL DEFAULT 'portfolio';
UPDATE research_documents SET topic_key = 'ticker:' || upper(trim(ticker)) WHERE ticker IS NOT NULL AND upper(trim(ticker)) <> 'PORTFOLIO' AND topic_key = 'portfolio';
CREATE INDEX IF NOT EXISTS research_documents_topic_idx ON research_documents(owner, topic_key);
CREATE TABLE IF NOT EXISTS research_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, report_id uuid NOT NULL REFERENCES research_documents(id),
  version integer NOT NULL CHECK (version > 0), idempotency_key text NOT NULL, content_hash varchar(64) NOT NULL,
  title text NOT NULL, kind varchar(16) NOT NULL CHECK (kind IN ('daily','deep','portfolio','council')), ticker varchar(30),
  content text NOT NULL, sections jsonb NOT NULL, source jsonb, snapshot jsonb, data_as_of timestamptz, available_at timestamptz,
  parent_version_id uuid REFERENCES research_document_versions(id), change_reason text, revoked_at timestamptz, revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_versions_number_idx ON research_document_versions(report_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS research_versions_key_idx ON research_document_versions(owner, idempotency_key);
CREATE INDEX IF NOT EXISTS research_versions_owner_idx ON research_document_versions(owner, report_id);
CREATE INDEX IF NOT EXISTS research_versions_source_idx ON research_document_versions(owner, (source->>'type'), (source->>'id'));
CREATE TABLE IF NOT EXISTS research_revision_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, report_id uuid NOT NULL REFERENCES research_documents(id),
  parent_version_id uuid NOT NULL REFERENCES research_document_versions(id), revision integer NOT NULL DEFAULT 1,
  title text NOT NULL, content text NOT NULL, sections jsonb NOT NULL, change_reason text NOT NULL,
  published_version_id uuid REFERENCES research_document_versions(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_revision_drafts_owner_idx ON research_revision_drafts(owner, report_id);
CREATE TABLE IF NOT EXISTS research_document_strategy_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, version_id uuid NOT NULL REFERENCES research_document_versions(id),
  strategy_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_document_strategy_use_idx ON research_document_strategy_uses(owner, version_id, strategy_id);
CREATE INDEX IF NOT EXISTS research_document_strategy_owner_idx ON research_document_strategy_uses(owner, version_id);
CREATE TABLE IF NOT EXISTS research_document_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, key text NOT NULL, payload_hash varchar(64) NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_document_submissions_key_idx ON research_document_submissions(owner, key);
CREATE TABLE IF NOT EXISTS research_document_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, report_id uuid NOT NULL REFERENCES research_documents(id),
  version_id uuid NOT NULL REFERENCES research_document_versions(id), previous_version_id uuid REFERENCES research_document_versions(id),
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_document_adoptions_owner_idx ON research_document_adoptions(owner, report_id, created_at);
ALTER TABLE research_revision_drafts ADD COLUMN IF NOT EXISTS source_references jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE OR REPLACE FUNCTION enforce_research_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason') THEN
    RAISE EXCEPTION 'REPORT_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS research_version_immutable ON research_document_versions;
CREATE TRIGGER research_version_immutable BEFORE UPDATE ON research_document_versions FOR EACH ROW EXECUTE FUNCTION enforce_research_version_immutable();

-- 27_research_threads.sql
-- Additive scene and immutable branch context; legacy stock rooms retain their identity.
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS scene varchar(24) NOT NULL DEFAULT 'stock';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT '';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS period jsonb;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS parent_session_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS parent_message_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS parent_report_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS report_references jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS resolved_references jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS inherited_context jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS research_version_id uuid;
UPDATE council_sessions SET title = ticker WHERE title = '';
UPDATE council_sessions SET subject = ticker WHERE subject = '';
CREATE INDEX IF NOT EXISTS council_sessions_parent_idx ON council_sessions(owner, parent_session_id);

ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS continuation_summary jsonb;
CREATE TABLE IF NOT EXISTS council_revision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  request_key uuid NOT NULL, input_hash varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending', result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner, request_key)
);

-- 28_simulation_experiments.sql
-- Additive: existing ledgers retain their USD settlement semantics and all history.
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Paper account';
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS ledger_mode text NOT NULL DEFAULT 'legacy_usd';
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS execution_model jsonb NOT NULL DEFAULT '{"version":"paper-v1","feeBps":0,"slippageBps":0,"corporateActions":"unsupported"}';
ALTER TABLE paper_accounts DROP CONSTRAINT IF EXISTS paper_accounts_owner_unique;
CREATE UNIQUE INDEX IF NOT EXISTS paper_accounts_active_owner ON paper_accounts(owner) WHERE is_active;
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS restricted_shares numeric NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS simulation_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, seed jsonb NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS simulation_seeds (
  account_id uuid PRIMARY KEY REFERENCES paper_accounts(id), owner text NOT NULL,
  preview_id uuid NOT NULL UNIQUE REFERENCES simulation_previews(id), idempotency_key text NOT NULL,
  request_hash text NOT NULL, seed jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_seed_idempotency UNIQUE(owner, idempotency_key)
);
CREATE TABLE IF NOT EXISTS simulation_cash (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES paper_accounts(id),
  owner text NOT NULL, currency text NOT NULL, available numeric NOT NULL DEFAULT 0 CHECK(available >= 0),
  frozen numeric NOT NULL DEFAULT 0 CHECK(frozen >= 0), unsettled numeric NOT NULL DEFAULT 0 CHECK(unsettled >= 0),
  availability_known boolean NOT NULL DEFAULT false,
  CONSTRAINT simulation_cash_account_currency UNIQUE(account_id, currency)
);
CREATE TABLE IF NOT EXISTS simulation_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES paper_accounts(id),
  currency text NOT NULL, amount numeric NOT NULL CHECK(amount >= 0), available_at timestamptz NOT NULL, settled_at timestamptz
);
CREATE OR REPLACE FUNCTION reject_simulation_seed_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Simulation opening seed is immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS simulation_seed_immutable ON simulation_seeds;
CREATE TRIGGER simulation_seed_immutable BEFORE UPDATE OR DELETE ON simulation_seeds
FOR EACH ROW EXECUTE FUNCTION reject_simulation_seed_mutation();

ALTER TABLE paper_snapshots ADD COLUMN IF NOT EXISTS benchmark_equity numeric;
ALTER TABLE paper_snapshots ADD COLUMN IF NOT EXISTS index_benchmark_equity numeric;
-- Unknown historical valuation instants remain null; created_at was not updated on revaluation.
ALTER TABLE paper_snapshots ADD COLUMN IF NOT EXISTS valued_at timestamptz;

-- 29_strategy_mandates.sql
CREATE TABLE IF NOT EXISTS strategy_mandates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL, profile_id uuid NOT NULL,
 profile_version integer NOT NULL, version integer NOT NULL DEFAULT 1, revision integer NOT NULL DEFAULT 1, parent_id uuid,
 status text NOT NULL DEFAULT 'draft', config jsonb NOT NULL, published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_mandate_published_account ON strategy_mandates(owner, account_id) WHERE status = 'published';
CREATE TABLE IF NOT EXISTS strategy_route_reviews (
 signal_id uuid PRIMARY KEY, owner text NOT NULL, account_id uuid NOT NULL, mandate_id uuid, decision jsonb NOT NULL,
 council_session_id uuid, council_report_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_route_signal_unique ON strategy_route_reviews(signal_id);
ALTER TABLE strategy_tasks ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'legacy';
ALTER TABLE strategy_tasks DROP CONSTRAINT IF EXISTS strategy_task_unique;
DROP INDEX IF EXISTS strategy_task_unique;
CREATE UNIQUE INDEX IF NOT EXISTS strategy_task_unique ON strategy_tasks(owner,profile_id,profile_version,market,market_date,attempt,scope_key);
ALTER TABLE strategy_plans ADD COLUMN IF NOT EXISTS account_id uuid;
ALTER TABLE strategy_plans ADD COLUMN IF NOT EXISTS mandate_id uuid;
ALTER TABLE strategy_plans ADD COLUMN IF NOT EXISTS mandate_version integer;
CREATE TABLE IF NOT EXISTS strategy_monitor_state (
 account_id uuid PRIMARY KEY, owner text NOT NULL, last_heartbeat timestamptz NOT NULL, gaps jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS strategy_review_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL, key text NOT NULL UNIQUE,
 from_date text NOT NULL, to_date text NOT NULL, state text NOT NULL, report_version_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS strategy_reservations (
 signal_id uuid PRIMARY KEY, owner text NOT NULL, account_id uuid NOT NULL, ticker text NOT NULL, side text NOT NULL, currency text NOT NULL,
 cash numeric NOT NULL, shares numeric NOT NULL, status text NOT NULL DEFAULT 'active', reason text NOT NULL DEFAULT 'Candidate review',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_reservations_account ON strategy_reservations(owner,account_id,status,expires_at);
CREATE TABLE IF NOT EXISTS strategy_research_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, mandate_id uuid NOT NULL, account_id uuid NOT NULL,
 rule_id text NOT NULL, reason text NOT NULL, session_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_research_alert_rule ON strategy_research_alerts(mandate_id,rule_id);

-- 30_strategy_daily_adjustments.sql
-- Once-per-market-day bounded AI adjustment receipts; pending paid requests are never replayed.
CREATE TABLE IF NOT EXISTS strategy_daily_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  mandate_id uuid NOT NULL, mandate_version integer NOT NULL, mandate_revision integer NOT NULL,
  profile_id uuid NOT NULL, profile_version integer NOT NULL, account_id uuid NOT NULL,
  market text NOT NULL, market_date text NOT NULL, input_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending', input jsonb, output jsonb, rules jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_daily_adjustments_scope_idx
  ON strategy_daily_adjustments(owner, mandate_id, market, market_date);

-- 31_simple_experience.sql
CREATE TABLE IF NOT EXISTS experience_preferences (
  owner text PRIMARY KEY, timezone text NOT NULL DEFAULT 'Asia/Shanghai', default_members jsonb NOT NULL DEFAULT '[]',
  default_account_id uuid, migration_state text NOT NULL DEFAULT 'new', enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_current_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner text NOT NULL,topic_key text NOT NULL,date_key text NOT NULL,
  current_document_id uuid REFERENCES research_document_versions(id),generation_key text,generation_sequence integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'empty',task_id uuid,task_kind text,automatic_task_id uuid,error text,change_summary text,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_current_view_identity ON research_current_views(owner,topic_key,date_key);
CREATE TABLE IF NOT EXISTS research_followup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner text NOT NULL,thesis_id uuid NOT NULL,observation_key text NOT NULL,
  due_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'queued',lease_token uuid,lease_until timestamptz,session_id uuid,
  result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_followup_identity ON research_followup_jobs(owner,thesis_id,observation_key);
CREATE INDEX IF NOT EXISTS research_followup_due ON research_followup_jobs(state,due_at);
-- An immutable material reference may never cross the owner's boundary.
CREATE OR REPLACE FUNCTION check_current_research_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_document_versions WHERE id=NEW.current_document_id AND owner=NEW.owner) THEN
    RAISE EXCEPTION 'CURRENT_RESEARCH_OWNER_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS current_research_owner ON research_current_views;
CREATE TRIGGER current_research_owner BEFORE INSERT OR UPDATE ON research_current_views FOR EACH ROW EXECUTE FUNCTION check_current_research_owner();

-- 32_autonomous_investment.sql
-- Additive persistent authorization. No existing account is implicitly enrolled.
CREATE TABLE IF NOT EXISTS investment_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), status text NOT NULL DEFAULT 'paused' CHECK(status IN ('running','paused','archived')),
 base_config jsonb NOT NULL, effective_config jsonb NOT NULL, constraint_records jsonb NOT NULL DEFAULT '[]',
 confirmed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner,account_id), FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
);
CREATE TABLE IF NOT EXISTS investment_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
 origin text NOT NULL, seed jsonb NOT NULL, source_preview_id uuid, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_key)
);
CREATE TABLE IF NOT EXISTS investment_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, operation text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_key)
);
CREATE TABLE IF NOT EXISTS investment_cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL REFERENCES paper_accounts(id),
 policy_id uuid NOT NULL REFERENCES investment_policies(id), policy_revision integer NOT NULL,
 market text NOT NULL, market_date text NOT NULL, trigger text NOT NULL, event_key text NOT NULL, priority integer NOT NULL DEFAULT 2,
 state text NOT NULL DEFAULT 'queued', lease_token uuid, lease_until timestamptz,
 input jsonb NOT NULL DEFAULT '{}', candidates jsonb NOT NULL DEFAULT '[]', result jsonb NOT NULL DEFAULT '{}', mandate_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner,policy_id,policy_revision,market,market_date,event_key)
);
CREATE INDEX IF NOT EXISTS investment_cycle_queue ON investment_cycles(state,priority,created_at);
CREATE TABLE IF NOT EXISTS investment_constraint_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL REFERENCES paper_accounts(id),
 expected_policy_revision integer NOT NULL, "constraint" jsonb, text text NOT NULL, impact text NOT NULL, needs_input jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'proposed', expires_at timestamptz NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_key)
);
CREATE TABLE IF NOT EXISTS automatic_research_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid REFERENCES paper_accounts(id),
 key text NOT NULL, purpose text NOT NULL, date_key text NOT NULL, calls integer NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 12),
 state text NOT NULL DEFAULT 'claimed', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,key)
);
CREATE INDEX IF NOT EXISTS automatic_research_owner_day ON automatic_research_tasks(owner,date_key);
ALTER TABLE strategy_mandates ADD COLUMN IF NOT EXISTS parent_policy_id uuid REFERENCES investment_policies(id);
ALTER TABLE strategy_mandates ADD COLUMN IF NOT EXISTS parent_policy_revision integer;
ALTER TABLE strategy_mandates ADD COLUMN IF NOT EXISTS cycle_id uuid REFERENCES investment_cycles(id);
ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS parent_policy_id uuid REFERENCES investment_policies(id);
ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS parent_policy_revision integer;
ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS cycle_id uuid REFERENCES investment_cycles(id);
-- Composite ownership fences remain effective for every writer, not just HTTP handlers.
CREATE UNIQUE INDEX IF NOT EXISTS paper_account_owner_identity ON paper_accounts(owner,id);
CREATE UNIQUE INDEX IF NOT EXISTS investment_policy_owner_identity ON investment_policies(owner,id);
CREATE UNIQUE INDEX IF NOT EXISTS investment_policy_owner_account_identity ON investment_policies(owner,account_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS investment_cycle_owner_identity ON investment_cycles(owner,id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='investment_policies'::regclass AND conname='investment_policy_owned_account') THEN
  ALTER TABLE investment_policies ADD CONSTRAINT investment_policy_owned_account FOREIGN KEY(owner,account_id) REFERENCES paper_accounts(owner,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='investment_cycles'::regclass AND conname='investment_cycle_owned_policy') THEN
  ALTER TABLE investment_cycles ADD CONSTRAINT investment_cycle_owned_policy FOREIGN KEY(owner,account_id,policy_id) REFERENCES investment_policies(owner,account_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='investment_constraint_proposals'::regclass AND conname='investment_constraint_owned_account') THEN
  ALTER TABLE investment_constraint_proposals ADD CONSTRAINT investment_constraint_owned_account FOREIGN KEY(owner,account_id) REFERENCES paper_accounts(owner,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='automatic_research_tasks'::regclass AND conname='automatic_research_owned_account') THEN
  ALTER TABLE automatic_research_tasks ADD CONSTRAINT automatic_research_owned_account FOREIGN KEY(owner,account_id) REFERENCES paper_accounts(owner,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='strategy_mandates'::regclass AND conname='mandate_owned_parent_policy') THEN
  ALTER TABLE strategy_mandates ADD CONSTRAINT mandate_owned_parent_policy FOREIGN KEY(owner,account_id,parent_policy_id) REFERENCES investment_policies(owner,account_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='strategy_signals'::regclass AND conname='signal_owned_parent_policy') THEN
  ALTER TABLE strategy_signals ADD CONSTRAINT signal_owned_parent_policy FOREIGN KEY(owner,parent_policy_id) REFERENCES investment_policies(owner,id);
 END IF;
END $$;

-- 33_simple_council.sql
-- Additive, owner-scoped research entry identities and private independent submissions.
CREATE UNIQUE INDEX IF NOT EXISTS council_sessions_owner_id_unique ON council_sessions(owner, id);
CREATE TABLE IF NOT EXISTS simple_council_requests (
  owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simple_council_requests_owner_session_fk FOREIGN KEY(owner, session_id) REFERENCES council_sessions(owner, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS simple_council_requests_owner_key ON simple_council_requests(owner, request_key);
CREATE TABLE IF NOT EXISTS council_independent_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, session_id uuid NOT NULL, cycle_id uuid NOT NULL,
  member_id text NOT NULL, executor_identity jsonb NOT NULL, attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
  contribution jsonb NOT NULL, evidence jsonb NOT NULL, tokens_used integer NOT NULL CHECK(tokens_used >= 0),
  task_id text, external_usage_unknown text, submitted_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  CONSTRAINT council_independent_owner_session_fk FOREIGN KEY(owner, session_id) REFERENCES council_sessions(owner, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS council_independent_submission_unique ON council_independent_submissions(owner, session_id, cycle_id, member_id, attempt);
CREATE OR REPLACE FUNCTION preserve_council_independent_submission() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
    OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'Independent submissions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS council_independent_immutable ON council_independent_submissions;
CREATE TRIGGER council_independent_immutable BEFORE UPDATE ON council_independent_submissions
  FOR EACH ROW EXECUTE FUNCTION preserve_council_independent_submission();

-- 34_research_execution_recovery.sql
-- Additive execution metadata. Existing running work is never replayed by migration.
ALTER TABLE experience_preferences ADD COLUMN IF NOT EXISTS member_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS council_member_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, session_id uuid NOT NULL, cycle_id uuid NOT NULL,
  member_id text NOT NULL, attempt integer NOT NULL CHECK(attempt > 0), revision integer NOT NULL, turn integer NOT NULL,
  resource_key text NOT NULL, input_hash text NOT NULL, input_snapshot jsonb NOT NULL, message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id text, dispatch_started boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'queued', result_acceptance text NOT NULL DEFAULT 'pending',
  raw_text text, tokens_used integer NOT NULL DEFAULT 0 CHECK(tokens_used >= 0), failure jsonb, failure_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner, session_id) REFERENCES council_sessions(owner, id) ON DELETE CASCADE,
  CHECK(status IN ('queued','running','completed','failed','cancelled','unknown','skipped')),
  CHECK(result_acceptance IN ('pending','accepted','rejected'))
);
ALTER TABLE council_member_attempts ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS council_member_attempt_identity ON council_member_attempts(owner,session_id,cycle_id,member_id,attempt);
CREATE INDEX IF NOT EXISTS council_member_attempt_active ON council_member_attempts(owner,session_id,cycle_id,status);
CREATE TABLE IF NOT EXISTS council_recovery_requests (
  owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, session_id uuid NOT NULL,
  member_id text NOT NULL, attempt_id uuid, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner,session_id) REFERENCES council_sessions(owner,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS council_recovery_owner_request ON council_recovery_requests(owner,request_key);

-- 35_import_batches.sql
-- Durable owner-scoped screenshot review; original image bytes remain local for at most 24h.
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY, owner text NOT NULL, revision integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batches_owner_updated ON import_batches(owner,updated_at DESC);
CREATE TABLE IF NOT EXISTS import_commit_receipts (
  id uuid PRIMARY KEY, owner text NOT NULL, batch_id uuid, request_key text NOT NULL,
  input_hash text NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS import_commit_receipt_identity ON import_commit_receipts(owner,request_key);

-- 36_import_analysis_handoff.sql
CREATE TABLE IF NOT EXISTS research_analysis_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, receipt_id text NOT NULL,
  snapshot jsonb NOT NULL, date_key text NOT NULL, state text NOT NULL DEFAULT 'queued', error text, task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_analysis_request_receipt ON research_analysis_requests(owner,receipt_id);
ALTER TABLE research_current_views ADD COLUMN IF NOT EXISTS dispatch_snapshot jsonb;
ALTER TABLE research_current_views ADD COLUMN IF NOT EXISTS dispatch_route jsonb;
ALTER TABLE research_current_views ADD COLUMN IF NOT EXISTS dispatch_connection_id text;

-- 37_asset_ledger_integrity.sql
-- Preserve original duplicate evidence before enforcing one current cash row.
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS reconciliation_status varchar(20) NOT NULL DEFAULT 'unconfirmed';
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS confirmed_at timestamptz(3);
CREATE TABLE IF NOT EXISTS cash_account_conflicts (
  id uuid PRIMARY KEY, owner text NOT NULL, currency varchar(10) NOT NULL,
  original jsonb NOT NULL, archived_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cash_balance_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, request_key text NOT NULL,
  input_hash text NOT NULL, changes jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_confirmations_owner_request ON cash_balance_confirmations(owner,request_key);

CREATE TABLE IF NOT EXISTS position_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  ticker varchar(20) NOT NULL, market varchar(10) NOT NULL, currency varchar(10) NOT NULL,
  shares numeric NOT NULL, avg_cost numeric, company text, source text NOT NULL, source_id text,
  observed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  covered_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  covered_closed_ids jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_baselines_owner_ticker ON position_baselines(owner, ticker);
CREATE TABLE IF NOT EXISTS asset_ledger_migrations (
  migration_key text PRIMARY KEY, applied_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Startup replays additive SQL. Only the first upgrade may reinterpret legacy balances/history.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':asset-ledger-upgrade', 0));
  IF NOT EXISTS (SELECT 1 FROM asset_ledger_migrations WHERE migration_key = '37_asset_ledger_integrity') THEN
    WITH duplicates AS (
      SELECT owner, currency FROM cash_accounts GROUP BY owner, currency HAVING count(*) > 1
    )
    INSERT INTO cash_account_conflicts(id, owner, currency, original)
    SELECT c.id, c.owner, c.currency, to_jsonb(c) FROM cash_accounts c
    JOIN duplicates d USING(owner, currency) ON CONFLICT(id) DO NOTHING;
    WITH groups AS (
      SELECT owner, currency, (array_agg(id ORDER BY _created_at, id))[1] AS keep_id,
        count(*) AS n, bool_or(balance <> 0) AS nonzero
      FROM cash_accounts GROUP BY owner, currency
    )
    UPDATE cash_accounts c SET reconciliation_status = CASE
      WHEN c.reconciliation_status = 'review' THEN 'review'
      WHEN g.n > 1 AND g.nonzero THEN 'review'
      WHEN c.balance <> 0 THEN 'confirmed' ELSE c.reconciliation_status END
    FROM groups g WHERE c.id = g.keep_id;
    WITH ranked AS (
      SELECT id, row_number() OVER(PARTITION BY owner, currency ORDER BY _created_at, id) AS n FROM cash_accounts
    )
    DELETE FROM cash_accounts c USING ranked r WHERE c.id = r.id AND r.n > 1;
    UPDATE cash_accounts SET confirmed_at = CURRENT_TIMESTAMP WHERE reconciliation_status = 'confirmed' AND confirmed_at IS NULL;
    -- Existing positions are checkpoints of known state. Historical trades stay untouched.
    INSERT INTO position_baselines(owner,ticker,market,currency,shares,avg_cost,company,source,source_id,covered_transaction_ids,covered_closed_ids)
    SELECT h.owner,h.ticker,coalesce(h.market,'US'),coalesce(h.currency,'USD'),h.shares,h.buy_price,h.company,
      'upgrade-checkpoint',h.id::text,coalesce((SELECT jsonb_agg(t.id::text) FROM transactions t WHERE t.owner=h.owner AND t.ticker=h.ticker),'[]'::jsonb),
      coalesce((SELECT jsonb_agg(c.id::text) FROM closed c WHERE c.owner=h.owner AND c.ticker=h.ticker),'[]'::jsonb)
    FROM holdings h WHERE h.shares > 0 ON CONFLICT(owner,ticker) DO NOTHING;
    INSERT INTO asset_ledger_migrations(migration_key) VALUES ('37_asset_ledger_integrity');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_owner_currency ON cash_accounts(owner, currency);

-- 39_user_investment_strategies.sql
-- Additive strategy authoring workspace. Existing policies, mandates, accounts and orders are preserved.
CREATE TABLE IF NOT EXISTS user_investment_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, revision integer NOT NULL DEFAULT 1,
  parent_id uuid, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')), content jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb, preview jsonb, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_investment_strategies_owner_updated ON user_investment_strategies(owner,updated_at);
CREATE TABLE IF NOT EXISTS user_investment_strategy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  strategy_id uuid NOT NULL REFERENCES user_investment_strategies(id), revision integer NOT NULL, snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_investment_strategy_revision_unique ON user_investment_strategy_revisions(owner,strategy_id,revision);
CREATE TABLE IF NOT EXISTS user_investment_strategy_current (
  owner text PRIMARY KEY, strategy_id uuid NOT NULL REFERENCES user_investment_strategies(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_investment_strategy_preparations (
  owner text NOT NULL, request_key text NOT NULL, strategy_id uuid NOT NULL REFERENCES user_investment_strategies(id),
  input_hash text NOT NULL, status text NOT NULL CHECK (status IN ('pending','succeeded','failed')), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_investment_strategy_preparation_key ON user_investment_strategy_preparations(owner,request_key);

-- 40_transaction_imports.sql
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_identity text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_fingerprint text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_batch_id uuid;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_data jsonb;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS linked_transaction_id uuid;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ledger_order bigint GENERATED BY DEFAULT AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_owner_source_identity ON transactions(owner,source_identity);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_owner_source_fingerprint ON transactions(owner,source_fingerprint) WHERE source_identity IS NULL;
CREATE TABLE IF NOT EXISTS transaction_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  input jsonb NOT NULL, rows jsonb NOT NULL, revision integer NOT NULL DEFAULT 0,
  receipts jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transaction_import_batches_owner ON transaction_import_batches(owner);

-- 41_portfolio_value_points.sql
CREATE TABLE IF NOT EXISTS portfolio_value_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, date_key text NOT NULL, slot text NOT NULL,
  captured_at timestamptz NOT NULL, total_value_usd numeric, known_value_usd numeric NOT NULL,
  complete boolean NOT NULL, estimated boolean NOT NULL, external_flows jsonb NOT NULL DEFAULT '[]'::jsonb,
  cash_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb, position_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS cash_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS position_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_value_point_slot ON portfolio_value_points(owner,slot);

-- 42_user_strategy_runtime.sql
-- Managed accounts need explicit investor strategy authority before resuming.
-- Preserve all ledgers, snapshots, reports and completed trades. Idempotent on upgrade.
UPDATE investment_policies SET status = 'paused', revision = revision + 1, updated_at = NOW()
WHERE status = 'running' AND base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio');
UPDATE paper_accounts a SET bot_enabled = FALSE, updated_at = NOW()
FROM investment_policies p WHERE p.account_id = a.id AND p.owner = a.owner
AND p.status = 'paused' AND p.base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio') AND a.bot_enabled = TRUE;
UPDATE investment_cycles c SET state = 'cancelled', updated_at = NOW(), result = jsonb_build_object('reason', 'Confirm an investor strategy before execution')
FROM investment_policies p WHERE p.id = c.policy_id AND p.owner = c.owner AND p.base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio')
AND c.state IN ('queued', 'researching', 'waiting');
UPDATE strategy_mandates m SET status = 'paused', updated_at = NOW()
FROM investment_policies p WHERE p.account_id = m.account_id AND p.owner = m.owner AND p.base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio') AND m.status = 'published';
UPDATE strategy_reservations r SET status = 'released', reason = 'Confirm an investor strategy before execution', updated_at = NOW()
FROM investment_policies p WHERE p.account_id = r.account_id AND p.owner = r.owner AND p.base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio') AND r.status = 'active';
UPDATE strategy_signals s SET state = 'cancelled', reason = 'Confirm an investor strategy before execution', updated_at = NOW()
FROM investment_policies p WHERE p.owner = s.owner AND s.candidate ->> 'accountId' = p.account_id::text
AND p.base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio') AND s.state IN ('claimed', 'pending', 'reviewing', 'approved', 'wait');
CREATE TABLE IF NOT EXISTS simulation_valuation_baselines (
  account_id UUID PRIMARY KEY,
  owner TEXT NOT NULL,
  seed JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION reject_simulation_valuation_baseline_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Simulation valuation baseline is immutable'; END;
$$;
DROP TRIGGER IF EXISTS simulation_valuation_baseline_immutable ON simulation_valuation_baselines;
CREATE TRIGGER simulation_valuation_baseline_immutable BEFORE UPDATE OR DELETE ON simulation_valuation_baselines
FOR EACH ROW EXECUTE FUNCTION reject_simulation_valuation_baseline_mutation();

UPDATE paper_orders o SET status = 'cancelled', reason = 'Confirm an investor strategy before execution'
FROM investment_policies p WHERE p.account_id = o.account_id AND p.owner = o.owner
AND p.base_config -> 'userStrategy' IS NULL AND NOT (base_config ? 'portfolio') AND o.status = 'pending_approval';

-- 43_channel_workbench.sql
-- Additive channel state. Existing accounts, reports and execution ledgers are untouched.
CREATE TABLE IF NOT EXISTS channel_preferences (
 owner text PRIMARY KEY, vibe text NOT NULL DEFAULT 'deskmate' CHECK(vibe IN ('quiet','deskmate','chatty')),
 pinned_bubble_id text, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channel_reports (
 id text NOT NULL, owner text NOT NULL, revision integer NOT NULL, title text NOT NULL, content text NOT NULL,
 section_ids jsonb NOT NULL, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_report_identity ON channel_reports(owner,id,revision);
CREATE TABLE IF NOT EXISTS channel_facts (
 id text NOT NULL, owner text NOT NULL, revision integer NOT NULL, data jsonb NOT NULL, card jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_fact_identity ON channel_facts(owner,id,revision);
CREATE TABLE IF NOT EXISTS channel_episodes (
 id text NOT NULL, owner text NOT NULL, title text NOT NULL, data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_episode_identity ON channel_episodes(owner,id);
CREATE INDEX IF NOT EXISTS channel_episode_owner_updated ON channel_episodes(owner,updated_at);
CREATE TABLE IF NOT EXISTS channel_events (
 id text NOT NULL, owner text NOT NULL, episode_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_event_identity ON channel_events(owner,id);
CREATE INDEX IF NOT EXISTS channel_event_episode ON channel_events(owner,episode_id);
CREATE TABLE IF NOT EXISTS channel_bubbles (
 id text NOT NULL, owner text NOT NULL, episode_id text NOT NULL, semantic_delta_id text NOT NULL, data jsonb NOT NULL,
 resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_bubble_id ON channel_bubbles(owner,id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_bubble_publication ON channel_bubbles(owner,episode_id,semantic_delta_id);
CREATE INDEX IF NOT EXISTS channel_bubble_owner_created ON channel_bubbles(owner,created_at);
CREATE TABLE IF NOT EXISTS channel_outbox (
 id text PRIMARY KEY, owner text NOT NULL, bubble_id text NOT NULL, destination text NOT NULL,
 state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_outbox_delivery ON channel_outbox(bubble_id,destination);
CREATE INDEX IF NOT EXISTS channel_outbox_owner ON channel_outbox(owner,created_at);
CREATE TABLE IF NOT EXISTS channel_findings (
 id text NOT NULL, owner text NOT NULL, data jsonb NOT NULL, seal jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_finding_identity ON channel_findings(owner,id);
CREATE TABLE IF NOT EXISTS channel_briefs (
 id text NOT NULL, owner text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_brief_identity ON channel_briefs(owner,id);
CREATE TABLE IF NOT EXISTS template_registry (
 id text NOT NULL, revision integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS template_registry_identity ON template_registry(id,revision);
CREATE TABLE IF NOT EXISTS channel_supplement_requests (
 id text NOT NULL, owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, message text NOT NULL,
 data jsonb NOT NULL, result jsonb, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((data->>'claimedToolCalls')::integer BETWEEN 0 AND 1), CHECK((data->>'maxToolCalls')::integer=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_supplement_id ON channel_supplement_requests(owner,id);
ALTER TABLE channel_supplement_requests ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS channel_supplement_request ON channel_supplement_requests(owner,request_key);
CREATE TABLE IF NOT EXISTS channel_deferred_questions (
 id text NOT NULL, owner text NOT NULL, request_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_deferred_identity ON channel_deferred_questions(owner,id);
CREATE TABLE IF NOT EXISTS channel_user_actions (
 id text PRIMARY KEY, owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL,
 data jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_action_request ON channel_user_actions(owner,request_key);
CREATE TABLE IF NOT EXISTS channel_memories (
 id text NOT NULL, owner text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_memory_identity ON channel_memories(owner,id);
CREATE TABLE IF NOT EXISTS channel_decision_reflections (
 id text NOT NULL, owner text NOT NULL, decision_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_reflection_identity ON channel_decision_reflections(owner,id);
CREATE INDEX IF NOT EXISTS channel_reflection_decision ON channel_decision_reflections(owner,decision_id);
CREATE OR REPLACE FUNCTION channel_assert_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CHANNEL_APPEND_ONLY'; END $$;
DROP TRIGGER IF EXISTS channel_memory_append_only ON channel_memories;
CREATE TRIGGER channel_memory_append_only BEFORE UPDATE OR DELETE ON channel_memories FOR EACH ROW EXECUTE FUNCTION channel_assert_append_only();
DROP TRIGGER IF EXISTS channel_reflection_append_only ON channel_decision_reflections;
CREATE TRIGGER channel_reflection_append_only BEFORE UPDATE OR DELETE ON channel_decision_reflections FOR EACH ROW EXECUTE FUNCTION channel_assert_append_only();

-- 44_strategy_draft_deletion.sql
-- Keep deleted draft revisions and model-dispatch receipts for audit and deduplication.
ALTER TABLE user_investment_strategies ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 45_portfolio_workspace.sql
-- Historical migrations run on every boot. Retain their index names with
-- compatible account-scoped definitions so they cannot recreate singletons.
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES paper_accounts(id);
UPDATE builder_profiles p SET account_id = m.account_id
FROM strategy_mandates m
JOIN paper_accounts a ON a.id = m.account_id AND a.owner = m.owner AND a.is_active
WHERE p.id = m.profile_id AND p.owner = m.owner AND p.account_id IS NULL
  AND p.version = m.profile_version AND m.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM strategy_mandates other
    JOIN paper_accounts target ON target.id = other.account_id AND target.owner = other.owner AND target.is_active
    WHERE other.owner = p.owner AND other.profile_id = p.id AND other.profile_version = p.version
      AND other.status = 'published' AND other.account_id <> m.account_id
  );
DROP INDEX IF EXISTS paper_accounts_active_owner;
CREATE UNIQUE INDEX paper_accounts_active_owner ON paper_accounts(owner, id) WHERE is_active;
DROP INDEX IF EXISTS idx_builder_profiles_active;
CREATE UNIQUE INDEX idx_builder_profiles_active ON builder_profiles(owner, account_id)
  WHERE status = 'active' AND account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_builder_profiles_active_legacy ON builder_profiles(owner)
  WHERE status = 'active' AND account_id IS NULL;

CREATE TABLE IF NOT EXISTS portfolio_strategy_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id), strategy_id uuid NOT NULL,
  strategy_revision integer NOT NULL, allocation_pct numeric(7,4) NOT NULL CHECK (allocation_pct BETWEEN 0 AND 100),
  enabled boolean NOT NULL, snapshot jsonb NOT NULL, policy_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_assignment_account_strategy
  ON portfolio_strategy_assignments(owner, account_id, strategy_id);
CREATE TABLE IF NOT EXISTS portfolio_combination_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id), policy_revision integer NOT NULL,
  allocations jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_combination_revision
  ON portfolio_combination_revisions(owner, account_id, policy_revision);
CREATE TABLE IF NOT EXISTS portfolio_combination_drafts (
  owner text NOT NULL, account_id uuid NOT NULL REFERENCES paper_accounts(id),
  expected_policy_revision integer NOT NULL, allocations jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_combination_draft_account
  ON portfolio_combination_drafts(owner, account_id);
CREATE TABLE IF NOT EXISTS portfolio_combination_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id), policy_revision integer NOT NULL,
  preview_hash text NOT NULL, allocations jsonb NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Never turn an archived strategy/account back on. Only the live pre-upgrade
-- policy is backfilled, and existing combinations remain authoritative on boot.
INSERT INTO portfolio_strategy_assignments
  (owner, account_id, strategy_id, strategy_revision, allocation_pct, enabled, snapshot, policy_revision)
SELECT p.owner, p.account_id, (p.base_config->'userStrategy'->>'id')::uuid,
  (p.base_config->'userStrategy'->>'revision')::integer, 100, true, p.base_config->'userStrategy', p.revision
FROM investment_policies p JOIN paper_accounts a ON a.id = p.account_id AND a.owner = p.owner
WHERE a.is_active AND p.status <> 'archived' AND p.base_config->'userStrategy'->>'status' = 'confirmed'
  AND NOT (p.base_config ? 'portfolio')
ON CONFLICT (owner, account_id, strategy_id) DO NOTHING;
UPDATE investment_policies p SET
  base_config = jsonb_set(p.base_config, '{portfolio}', assignments.allocations),
  effective_config = jsonb_set(p.effective_config, '{portfolio}', assignments.allocations)
FROM (SELECT owner, account_id, jsonb_agg(jsonb_build_object(
  'strategyId', strategy_id, 'strategyRevision', strategy_revision,
  'allocationPct', allocation_pct, 'enabled', enabled, 'snapshot', snapshot)) AS allocations
  FROM portfolio_strategy_assignments GROUP BY owner, account_id) assignments
WHERE p.owner = assignments.owner AND p.account_id = assignments.account_id
  AND p.status <> 'archived' AND NOT (p.base_config ? 'portfolio');
INSERT INTO portfolio_combination_revisions(owner, account_id, policy_revision, allocations)
SELECT owner, account_id, revision, base_config->'portfolio' FROM investment_policies
WHERE base_config ? 'portfolio' AND status <> 'archived'
ON CONFLICT (owner, account_id, policy_revision) DO NOTHING;

-- 46_strategy_interviews.sql
-- Durable authoring state and idempotent actions; no execution policies are changed.
CREATE TABLE IF NOT EXISTS strategy_interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  account_id uuid NOT NULL,
  base_strategy_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_interviews_owner_account_updated
  ON strategy_interviews(owner, account_id, updated_at);
CREATE TABLE IF NOT EXISTS strategy_interview_requests (
  owner text NOT NULL,
  request_key text NOT NULL,
  input_hash text NOT NULL,
  interview_id uuid NOT NULL REFERENCES strategy_interviews(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_interview_request_owner_key
  ON strategy_interview_requests(owner, request_key);

-- 47_portfolio_companions.sql
-- Appearance is separate from execution authority. Existing accounts remain
-- unassigned until the owner explicitly chooses their companion.
CREATE TABLE IF NOT EXISTS portfolio_account_companions (
  owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id),
  companion_id text NOT NULL CHECK (companion_id IN ('value','growth','risk','technical','news','macro','moderator')),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_account_companion_identity
  ON portfolio_account_companions(owner, account_id);

-- 48_portfolio_history.sql
-- Additive public market-data caches. No portfolio, order or saved NAV rows are rewritten.
CREATE TABLE IF NOT EXISTS portfolio_history_prices (
  symbol text NOT NULL, market text NOT NULL, currency text NOT NULL,
  price_date date NOT NULL, close numeric NOT NULL CHECK (close > 0), source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_history_price_key ON portfolio_history_prices(symbol, price_date);
CREATE TABLE IF NOT EXISTS portfolio_history_fx (
  currency text NOT NULL, rate_date date NOT NULL, usd_rate numeric NOT NULL CHECK (usd_rate > 0), source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_history_fx_key ON portfolio_history_fx(currency, rate_date);
CREATE TABLE IF NOT EXISTS portfolio_history_fetches (
  resource text PRIMARY KEY, lease_token text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL,
  completed_at timestamptz, error text, coverage jsonb
);

-- 49_research_deletions.sql
-- Additive owner-scoped tombstones; immutable content, references and ledgers remain intact.
ALTER TABLE IF EXISTS research_document_versions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS council_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS research_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  request_key text NOT NULL, input_hash varchar(64) NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_deletion_requests_owner_key_idx ON research_deletion_requests(owner, request_key);

CREATE OR REPLACE FUNCTION enforce_research_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'RESEARCH_DELETED';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason' - 'deleted_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason' - 'deleted_at') THEN
    RAISE EXCEPTION 'REPORT_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_council_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'RESEARCH_DELETED';
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF to_regclass('council_sessions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS council_tombstone ON council_sessions;
    CREATE TRIGGER council_tombstone BEFORE UPDATE ON council_sessions
      FOR EACH ROW EXECUTE FUNCTION enforce_council_tombstone();
  END IF;
END $$;

-- 50_data_library.sql
CREATE TABLE IF NOT EXISTS data_library_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, kind text NOT NULL,
 title text NOT NULL, description text NOT NULL DEFAULT '', format text NOT NULL, url text,
 file_name text, mime_type text, file_data text, enabled boolean NOT NULL DEFAULT true,
 auth_kind text NOT NULL DEFAULT 'none', secret_enc text, sync_interval_minutes integer,
 next_sync_at timestamptz, latest_version_id uuid, version_count integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending', last_success_at timestamptz, last_error_code text,
 lease_until timestamptz, revision integer NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_library_owner_idx ON data_library_sources(owner, created_at);
CREATE INDEX IF NOT EXISTS data_library_due_idx ON data_library_sources(next_sync_at);
CREATE TABLE IF NOT EXISTS data_library_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
 source_id uuid NOT NULL REFERENCES data_library_sources(id), version integer NOT NULL,
 content_hash text NOT NULL, raw_content text NOT NULL, extracted_text text NOT NULL,
 sections jsonb NOT NULL, byte_length integer NOT NULL, extraction_state text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS data_library_version_idx ON data_library_versions(source_id, version);
CREATE INDEX IF NOT EXISTS data_library_version_owner_idx ON data_library_versions(owner, source_id);
CREATE INDEX IF NOT EXISTS data_library_text_idx ON data_library_versions USING gin(to_tsvector('simple', extracted_text));
CREATE TABLE IF NOT EXISTS data_library_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
 source_id uuid NOT NULL REFERENCES data_library_sources(id), state text NOT NULL,
 outcome text, version_id uuid, error_code text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_library_job_owner_idx ON data_library_jobs(owner, started_at);
CREATE TABLE IF NOT EXISTS financial_data_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, provider text NOT NULL,
 secret_enc text, enabled boolean NOT NULL DEFAULT true, last_test_at timestamptz,
 last_test_ok boolean, last_test_code text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_data_connection_owner_provider_idx ON financial_data_connections(owner, provider);

-- 51_browser_sources.sql
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'http';
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS browser_state_enc text;
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS browser_connected_at timestamptz;
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS active_job_id uuid;
ALTER TABLE data_library_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE data_library_versions ADD COLUMN IF NOT EXISTS acquisition text NOT NULL DEFAULT 'document';
ALTER TABLE data_library_versions ADD COLUMN IF NOT EXISTS final_url text;
ALTER TABLE data_library_versions ADD COLUMN IF NOT EXISTS page_title text;
UPDATE data_library_versions SET acquisition = 'http'
WHERE acquisition = 'document' AND source_id IN (SELECT id FROM data_library_sources WHERE kind = 'website');

-- 52_agent_telemetry.sql
-- Owner-scoped operational metadata, independent of private model contents.
CREATE TABLE IF NOT EXISTS telemetry_spans (
  owner text NOT NULL, id text NOT NULL, run_id text NOT NULL, source_id text NOT NULL,
  session_id text, revision integer, scene text NOT NULL, title text NOT NULL,
  parent_id text, kind text NOT NULL CHECK (kind IN ('task','agent','model','tool')),
  name text NOT NULL, status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','unknown')),
  agent_id text, agent_name text, provider text, model text, execution_mode text,
  started_at timestamptz NOT NULL, completed_at timestamptz, duration_ms integer CHECK(duration_ms >= 0),
  input_tokens integer CHECK(input_tokens >= 0), output_tokens integer CHECK(output_tokens >= 0), total_tokens integer CHECK(total_tokens >= 0),
  estimated_cost_usd numeric CHECK(estimated_cost_usd >= 0), error_code text, attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0), trace_id text,
  PRIMARY KEY(owner,id)
);
CREATE INDEX IF NOT EXISTS telemetry_spans_owner_date_idx ON telemetry_spans(owner,started_at);
CREATE INDEX IF NOT EXISTS telemetry_spans_owner_run_idx ON telemetry_spans(owner,run_id);
CREATE TABLE IF NOT EXISTS telemetry_feedback (
  owner text NOT NULL, run_id text NOT NULL, rating text NOT NULL CHECK(rating IN ('positive','negative')),
  comment text NOT NULL DEFAULT '' CHECK(length(comment) <= 2000), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,run_id)
);
