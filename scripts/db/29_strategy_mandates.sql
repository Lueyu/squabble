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
