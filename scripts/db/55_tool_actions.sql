CREATE TABLE IF NOT EXISTS tool_actions (
 id uuid PRIMARY KEY, owner text NOT NULL, run_id uuid NOT NULL, step_id uuid NOT NULL, tool_call_id text NOT NULL,
 tool_id text NOT NULL, connection_id uuid NOT NULL, connection_revision integer NOT NULL, catalog_version_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1, payload_hash text NOT NULL, arguments_hash text NOT NULL, preview_enc text NOT NULL,
 state text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL, approved_at timestamptz,
 invocation_id text, receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner, run_id, step_id, tool_call_id),
 CHECK (revision > 0), CHECK (state IN ('draft','pending','approved','rejected','dispatched','completed','failed','unknown'))
);
CREATE INDEX IF NOT EXISTS tool_action_owner_idx ON tool_actions(owner, created_at);
