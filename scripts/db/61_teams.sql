-- Teams are opt-in; this migration never invents teams for existing accounts.
CREATE TABLE IF NOT EXISTS teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', avatar text,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), display_json jsonb NOT NULL,
 display_revision integer NOT NULL DEFAULT 1, layout_json jsonb NOT NULL, layout_revision integer NOT NULL DEFAULT 1,
 binding_revision integer NOT NULL DEFAULT 0, scope_revision integer NOT NULL DEFAULT 0, account_id uuid, current_version_id uuid,
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner_id,id));
CREATE INDEX IF NOT EXISTS teams_owner_status_idx ON teams(owner_id,status,updated_at);
CREATE TABLE IF NOT EXISTS team_drafts (
 team_id uuid PRIMARY KEY, owner_id text NOT NULL, semantic_revision integer NOT NULL DEFAULT 1, base_version_id uuid,
 config_json jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id));
CREATE TABLE IF NOT EXISTS team_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL, owner_id text NOT NULL, version integer NOT NULL,
 semantic_revision integer NOT NULL, semantic_hash text NOT NULL, config_json jsonb NOT NULL, display_snapshot jsonb NOT NULL,
 created_by text NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner_id,id), UNIQUE(team_id,version),
 FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id));
CREATE TABLE IF NOT EXISTS team_account_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, team_id uuid NOT NULL, account_id uuid NOT NULL,
 binding_revision integer NOT NULL, team_version_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('active','superseded','released','archived')),
 previous_binding_id uuid, effective_from timestamptz(3) NOT NULL DEFAULT now(), effective_to timestamptz(3),
 execution_choice text NOT NULL CHECK(execution_choice IN ('keep_confirmed_rules','pause_all')), policy_snapshot jsonb,
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 CHECK(effective_to IS NULL OR effective_to >= effective_from), FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id),
 FOREIGN KEY(owner_id,team_version_id) REFERENCES team_versions(owner_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS team_bindings_active_team_idx ON team_account_bindings(team_id) WHERE state='active';
CREATE UNIQUE INDEX IF NOT EXISTS team_bindings_active_account_idx ON team_account_bindings(account_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS team_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, team_id uuid NOT NULL, kind text NOT NULL,
 payload_json jsonb NOT NULL, guards_json jsonb NOT NULL, preview_hash text NOT NULL, compiler_version text NOT NULL,
 expires_at timestamptz(3) NOT NULL, consumed_by_request_key text, created_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id));
CREATE TABLE IF NOT EXISTS team_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, request_key text NOT NULL CHECK(length(request_key)<=128),
 operation text NOT NULL, team_id uuid, input_hash text NOT NULL, result_json jsonb NOT NULL, http_status integer NOT NULL,
 completed_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner_id,request_key));
CREATE TABLE IF NOT EXISTS team_commissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, team_id uuid NOT NULL, account_id uuid NOT NULL,
 binding_id uuid NOT NULL, binding_revision integer NOT NULL, team_version_id uuid NOT NULL, scope_revision integer NOT NULL,
 commission_revision integer NOT NULL DEFAULT 1, preview_id uuid NOT NULL UNIQUE, plan_json jsonb NOT NULL,
 input_snapshot jsonb NOT NULL, member_snapshots jsonb NOT NULL, root_budget_task_id text NOT NULL,
 session_id uuid, cycle_id uuid, state text NOT NULL, budget_limit_json jsonb NOT NULL, budget_limit_revision integer NOT NULL DEFAULT 1,
 last_error_json jsonb, requested_by text NOT NULL, cancel_requested_at timestamptz(3), completed_at timestamptz(3),
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id), FOREIGN KEY(owner_id,binding_id) REFERENCES team_account_bindings(owner_id,id),
 FOREIGN KEY(owner_id,team_version_id) REFERENCES team_versions(owner_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS team_commissions_session_idx ON team_commissions(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS team_commissions_state_idx ON team_commissions(team_id,state,created_at);
CREATE TABLE IF NOT EXISTS team_commission_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text NOT NULL,commission_id uuid NOT NULL,kind text NOT NULL,
 command_key text NOT NULL,payload_json jsonb NOT NULL,state text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,
 lease_owner text,lease_until timestamptz(3),next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),last_error_json jsonb,
 created_at timestamptz(3) NOT NULL DEFAULT now(),updated_at timestamptz(3) NOT NULL DEFAULT now(),UNIQUE(commission_id,command_key),
 FOREIGN KEY(owner_id,commission_id) REFERENCES team_commissions(owner_id,id));
CREATE INDEX IF NOT EXISTS team_jobs_pending_idx ON team_commission_jobs(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS team_research_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text NOT NULL,team_id uuid NOT NULL,commission_id uuid NOT NULL,
 kind text NOT NULL,target_id text NOT NULL,target_revision text,relation text NOT NULL,work_key text,attempt_id text,
 metadata_json jsonb NOT NULL DEFAULT '{}',created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(commission_id,kind,target_id,target_revision,relation),
 FOREIGN KEY(owner_id,commission_id) REFERENCES team_commissions(owner_id,id), FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id));
CREATE TABLE IF NOT EXISTS team_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text NOT NULL,team_id uuid NOT NULL,account_id uuid NOT NULL,commission_id uuid,
 proposal_id uuid NOT NULL,proposal_revision integer NOT NULL,event text NOT NULL,actor_type text NOT NULL CHECK(actor_type IN ('user','agent','system')),
 actor_id text NOT NULL,basis_json jsonb NOT NULL,reason text NOT NULL,policy_context_json jsonb,request_key text NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner_id,id),UNIQUE(proposal_id,proposal_revision),
 FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id), FOREIGN KEY(owner_id,commission_id) REFERENCES team_commissions(owner_id,id));
CREATE TABLE IF NOT EXISTS team_source_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text NOT NULL,team_id uuid NOT NULL,source_kind text NOT NULL,
 source_id text NOT NULL,source_revision text NOT NULL,state text NOT NULL CHECK(state IN ('active','revoked')),granted_by text NOT NULL,
 granted_at timestamptz(3) NOT NULL DEFAULT now(),revoked_at timestamptz(3),reason text,UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,team_id) REFERENCES teams(owner_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS team_grants_active_idx ON team_source_grants(team_id,source_kind,source_id,source_revision) WHERE state='active';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS team_commission_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS team_context jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS council_sessions_team_commission_idx ON council_sessions(team_commission_id) WHERE team_commission_id IS NOT NULL;
ALTER TABLE council_research_tasks ADD COLUMN IF NOT EXISTS work_key text;
ALTER TABLE council_research_tasks ADD COLUMN IF NOT EXISTS dependency_work_keys jsonb;
ALTER TABLE council_research_tasks ADD COLUMN IF NOT EXISTS task_kind text;
ALTER TABLE council_research_tasks ADD COLUMN IF NOT EXISTS reviewer_member_id text;
ALTER TABLE council_research_tasks ADD COLUMN IF NOT EXISTS assignment_json jsonb;
-- Retain the legacy name so replaying 18 cannot restore the broad constraint.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass(format('%I.%I',current_schema(),'council_research_tasks_cycle_key_idx')) AND indpred IS NULL) THEN
  DROP INDEX council_research_tasks_cycle_key_idx;
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS council_research_tasks_cycle_key_idx ON council_research_tasks(session_id,cycle_id,key) WHERE work_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS council_research_tasks_cycle_work_key_idx ON council_research_tasks(session_id,cycle_id,work_key) WHERE work_key IS NOT NULL;
ALTER TABLE portfolio_combination_drafts ADD COLUMN IF NOT EXISTS team_decision_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE portfolio_combination_previews ADD COLUMN IF NOT EXISTS team_decision_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE portfolio_combination_revisions ADD COLUMN IF NOT EXISTS team_decision_refs jsonb NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX IF NOT EXISTS team_versions_team_identity_idx ON team_versions(owner_id,team_id,id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='teams_current_version_team_fk' AND connamespace=current_schema()::regnamespace) THEN
  ALTER TABLE teams ADD CONSTRAINT teams_current_version_team_fk FOREIGN KEY(owner_id,id,current_version_id)
   REFERENCES team_versions(owner_id,team_id,id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='team_bindings_version_team_fk' AND connamespace=current_schema()::regnamespace) THEN
  ALTER TABLE team_account_bindings ADD CONSTRAINT team_bindings_version_team_fk FOREIGN KEY(owner_id,team_id,team_version_id)
   REFERENCES team_versions(owner_id,team_id,id);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION reject_team_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'TEAM_IMMUTABLE_HISTORY'; END $$;
DROP TRIGGER IF EXISTS team_version_immutable ON team_versions;
CREATE TRIGGER team_version_immutable BEFORE UPDATE OR DELETE ON team_versions FOR EACH ROW EXECUTE FUNCTION reject_team_immutable_change();
DROP TRIGGER IF EXISTS team_decision_immutable ON team_decisions;
CREATE TRIGGER team_decision_immutable BEFORE UPDATE OR DELETE ON team_decisions FOR EACH ROW EXECUTE FUNCTION reject_team_immutable_change();
CREATE OR REPLACE FUNCTION fence_team_commission_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.owner_id,NEW.team_id,NEW.account_id,NEW.binding_id,NEW.binding_revision,NEW.team_version_id,NEW.scope_revision,
   NEW.preview_id,NEW.plan_json,NEW.input_snapshot,NEW.member_snapshots,NEW.requested_by)
  IS DISTINCT FROM ROW(OLD.owner_id,OLD.team_id,OLD.account_id,OLD.binding_id,OLD.binding_revision,OLD.team_version_id,OLD.scope_revision,
   OLD.preview_id,OLD.plan_json,OLD.input_snapshot,OLD.member_snapshots,OLD.requested_by) THEN
  RAISE EXCEPTION 'TEAM_IMMUTABLE_COMMISSION';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS team_commission_snapshot_immutable ON team_commissions;
CREATE TRIGGER team_commission_snapshot_immutable BEFORE UPDATE ON team_commissions FOR EACH ROW EXECUTE FUNCTION fence_team_commission_snapshot();
