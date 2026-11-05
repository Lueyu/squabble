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
