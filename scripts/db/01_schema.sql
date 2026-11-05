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
