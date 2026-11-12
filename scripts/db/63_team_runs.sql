-- Standing paper-only authority and conservative reservations survive process restarts.
CREATE TABLE IF NOT EXISTS team_run_agreements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, team_id uuid NOT NULL, account_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), state text NOT NULL CHECK (state IN ('confirmed','running','paused','suspended')),
 configuration_json jsonb NOT NULL, scope_revision integer NOT NULL, member_snapshots jsonb NOT NULL,
 confirmed_by text NOT NULL, confirmed_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(), suspension_reason text,
 UNIQUE (owner_id,team_id), UNIQUE (owner_id,id)
);
CREATE TABLE IF NOT EXISTS team_run_cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, team_id uuid NOT NULL, agreement_id uuid NOT NULL,
 agreement_revision integer NOT NULL CHECK (agreement_revision > 0), trading_date text NOT NULL,
 state text NOT NULL CHECK (state IN ('reserved','researching','processing','applied','observed','blocked','uncertain','cancelled')),
 commission_id uuid, report_version_id uuid, decision_id uuid, strategy_id uuid, policy_revision integer,
 reserved_cost_usd numeric(24,8) NOT NULL CHECK (reserved_cost_usd > 0), reserved_calls integer NOT NULL CHECK (reserved_calls > 0), last_error text,
 lease_owner text, lease_until timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_id,agreement_id) REFERENCES team_run_agreements(owner_id,id), UNIQUE (agreement_id,trading_date), UNIQUE (commission_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS team_run_cycles_active_idx ON team_run_cycles(agreement_id) WHERE state IN ('reserved','researching','processing','uncertain');
CREATE INDEX IF NOT EXISTS team_run_cycles_owner_idx ON team_run_cycles(owner_id,created_at);
CREATE TABLE IF NOT EXISTS team_run_agreement_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, agreement_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision > 0), state text NOT NULL CHECK (state IN ('confirmed','running','paused','suspended')),
 account_id uuid NOT NULL, configuration_json jsonb NOT NULL, member_snapshots jsonb NOT NULL, scope_revision integer NOT NULL,
 confirmed_by text NOT NULL, confirmed_at timestamptz(3) NOT NULL, suspension_reason text, created_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_id,agreement_id) REFERENCES team_run_agreements(owner_id,id), UNIQUE (agreement_id,revision)
);
-- Upgrade an already-created agreement without inventing prior consent revisions.
INSERT INTO team_run_agreement_revisions(owner_id,agreement_id,revision,state,account_id,configuration_json,member_snapshots,scope_revision,confirmed_by,confirmed_at,suspension_reason)
 SELECT owner_id,id,revision,state,account_id,configuration_json,member_snapshots,scope_revision,confirmed_by,confirmed_at,suspension_reason FROM team_run_agreements
 ON CONFLICT (agreement_id,revision) DO NOTHING;
DROP TRIGGER IF EXISTS team_run_revision_immutable ON team_run_agreement_revisions;
CREATE TRIGGER team_run_revision_immutable BEFORE UPDATE OR DELETE ON team_run_agreement_revisions FOR EACH ROW EXECUTE FUNCTION reject_team_immutable_change();
