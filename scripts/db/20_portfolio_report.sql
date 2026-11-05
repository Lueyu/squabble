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
