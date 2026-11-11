-- Durable runtime receipts are additive and never dispatch work during migration.
CREATE TABLE IF NOT EXISTS agent_runtime_runs (
  id uuid PRIMARY KEY, owner text NOT NULL, identity_hash text NOT NULL,
  identity jsonb NOT NULL, driver text NOT NULL, frozen_input_hash text NOT NULL,
  frozen_input_enc text NOT NULL, initial_request_enc text, initial_request_hash text,
  policy jsonb NOT NULL, state text NOT NULL DEFAULT 'queued',
  cursor integer NOT NULL DEFAULT 0, lease_token text, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner, identity_hash), UNIQUE(owner, id),
  CHECK(state IN ('queued','running','waiting_approval','cancelling','provider_unknown','result_received','accepted','failed','cancelled','settled_unknown'))
);
CREATE TABLE IF NOT EXISTS agent_runtime_steps (
  id uuid PRIMARY KEY, owner text NOT NULL, run_id uuid NOT NULL, step_index integer NOT NULL,
  dispatch_key text NOT NULL, request_hash text NOT NULL, request_enc text NOT NULL, model text NOT NULL,
  response_hash text, response_enc text, state text NOT NULL DEFAULT 'dispatched',
  budget_id uuid, provider_request_id text, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner, run_id) REFERENCES agent_runtime_runs(owner,id),
  UNIQUE(owner, run_id, step_index), UNIQUE(owner, dispatch_key), UNIQUE(owner,id), UNIQUE(owner,run_id,id)
);
CREATE TABLE IF NOT EXISTS agent_runtime_events (
  id bigserial PRIMARY KEY, owner text NOT NULL, run_id uuid NOT NULL, step_id uuid,
  kind text NOT NULL, code text, parse_attempt_id uuid, response_hash text, parser_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner, run_id) REFERENCES agent_runtime_runs(owner,id)
);
CREATE TABLE IF NOT EXISTS agent_tool_invocations (
  id uuid PRIMARY KEY, owner text NOT NULL, run_id uuid NOT NULL, step_id uuid NOT NULL,
  tool_call_id text NOT NULL, tool_id text NOT NULL, catalog_version_id text NOT NULL,
  arguments_hash text NOT NULL, arguments_enc text NOT NULL, result_enc text,
  state text NOT NULL DEFAULT 'queued', remote_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner,run_id) REFERENCES agent_runtime_runs(owner,id),
  FOREIGN KEY(owner,run_id,step_id) REFERENCES agent_runtime_steps(owner,run_id,id),
  UNIQUE(owner,run_id,step_id,tool_call_id), UNIQUE(owner,id)
);
CREATE TABLE IF NOT EXISTS agent_tool_budget_reservations (
  id uuid PRIMARY KEY, owner text NOT NULL, run_id uuid NOT NULL, invocation_id uuid NOT NULL,
  amount numeric NOT NULL CHECK(amount>=0), unit text NOT NULL, price_version text NOT NULL,
  actual_amount numeric, state text NOT NULL DEFAULT 'reserved', revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner,run_id) REFERENCES agent_runtime_runs(owner,id),
  FOREIGN KEY(owner,invocation_id) REFERENCES agent_tool_invocations(owner,id),
  UNIQUE(owner,invocation_id)
);
CREATE TABLE IF NOT EXISTS agent_tool_budget_events (
  owner text NOT NULL, reservation_id uuid NOT NULL, revision integer NOT NULL,
  state text NOT NULL, quantity numeric, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner,reservation_id,revision)
);
CREATE INDEX IF NOT EXISTS agent_runtime_owner_state ON agent_runtime_runs(owner,state);
-- Legacy budget rows keep null identities; only new paid dispatches opt into replay protection.
ALTER TABLE IF EXISTS llm_budget_usage ADD COLUMN IF NOT EXISTS dispatch_key text;
ALTER TABLE IF EXISTS llm_budget_usage ADD COLUMN IF NOT EXISTS request_hash text;
DO $$ BEGIN
  IF to_regclass('llm_budget_usage') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS llm_budget_dispatch_identity ON llm_budget_usage(owner,dispatch_key) WHERE dispatch_key IS NOT NULL;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS agent_model_usage_corrections (
  owner text NOT NULL, budget_id uuid NOT NULL, event_id text NOT NULL, prior_status text NOT NULL,
  prior_tokens integer NOT NULL, corrected_tokens integer NOT NULL, facts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,budget_id,event_id)
);
CREATE TABLE IF NOT EXISTS agent_model_capabilities (
  owner text NOT NULL, connection_id text NOT NULL, model text NOT NULL, config_hash text NOT NULL,
  run_id uuid NOT NULL, supported boolean NOT NULL, enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,connection_id,model,config_hash)
);
CREATE TABLE IF NOT EXISTS agent_runtime_driver_preferences (
  owner text NOT NULL, connection_id text NOT NULL, driver text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,connection_id),
  CHECK(driver IN ('controlled','deep_agents'))
);
CREATE TABLE IF NOT EXISTS agent_runtime_evidence_snapshots (
  owner text NOT NULL, run_id uuid NOT NULL, step_id uuid NOT NULL, content_hash text NOT NULL, content_enc text NOT NULL,
  PRIMARY KEY(owner,run_id,step_id), FOREIGN KEY(owner,run_id,step_id) REFERENCES agent_runtime_steps(owner,run_id,id)
);
-- Route is selected once per full member/turn/attempt identity, before any paid dispatch.
CREATE TABLE IF NOT EXISTS agent_runtime_execution_routes (
  owner text NOT NULL, identity_hash text NOT NULL, identity jsonb NOT NULL,
  route text NOT NULL CHECK(route IN ('legacy','controlled','deep_agents')), model_config jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,identity_hash)
);
ALTER TABLE agent_runtime_execution_routes DROP CONSTRAINT IF EXISTS agent_runtime_execution_routes_route_check;
ALTER TABLE agent_runtime_execution_routes ADD CONSTRAINT agent_runtime_execution_routes_route_check
  CHECK(route IN ('legacy','controlled','deep_agents'));
