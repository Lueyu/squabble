-- Owner scoped connection state; secrets never enter the public catalog.
CREATE TABLE IF NOT EXISTS tool_connections (
 id uuid PRIMARY KEY, owner text NOT NULL, provider text NOT NULL, transport text NOT NULL,
 endpoint text, secret_enc text, provider_config jsonb, revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'configured',
 allowed_tool_ids jsonb NOT NULL DEFAULT '[]', allowed_data_classes jsonb NOT NULL DEFAULT '["public"]',
 tool_effects jsonb NOT NULL DEFAULT '{}', catalog_version_id uuid, verified_at timestamptz,
 oauth_config jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT tool_connection_revision_positive CHECK (revision > 0)
);
CREATE INDEX IF NOT EXISTS tool_connection_owner_idx ON tool_connections(owner);
CREATE TABLE IF NOT EXISTS tool_catalog_versions (
 id uuid PRIMARY KEY, owner text NOT NULL, connection_id uuid NOT NULL REFERENCES tool_connections(id),
 connection_revision integer NOT NULL, schema_hash text NOT NULL, descriptors jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_catalog_owner_idx ON tool_catalog_versions(owner, connection_id);
CREATE TABLE IF NOT EXISTS tool_oauth_states (
 id uuid PRIMARY KEY, owner text NOT NULL, connection_id uuid NOT NULL REFERENCES tool_connections(id),
 connection_revision integer NOT NULL, state_hash text NOT NULL UNIQUE, verifier_enc text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS tool_remote_jobs (
 id uuid PRIMARY KEY, owner text NOT NULL, connection_id uuid NOT NULL REFERENCES tool_connections(id),
 connection_revision integer NOT NULL, invocation_id text NOT NULL, remote_job_id text NOT NULL,
 state text NOT NULL, limits jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner, invocation_id)
);
