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
