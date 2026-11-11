-- Preparation facts are deployment-scoped; business grants remain owner-scoped.
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS managed_preset_id text;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS candidate_catalog_version_id uuid;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS last_discovery_at timestamptz;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS last_discovery_code text;
CREATE UNIQUE INDEX IF NOT EXISTS tool_connections_managed_identity ON tool_connections(owner, managed_preset_id);

CREATE TABLE IF NOT EXISTS tool_capability_readiness (
  pack_id text PRIMARY KEY,
  manifest_hash text NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  facts jsonb NOT NULL DEFAULT '{}',
  reason_code text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tool_capability_grants (
  owner text NOT NULL,
  pack_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false,
  manifest_hash text NOT NULL,
  data_classes jsonb NOT NULL DEFAULT '["public"]',
  public_network boolean NOT NULL DEFAULT false,
  connection_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner, pack_id),
  CONSTRAINT tool_capability_pack CHECK (pack_id IN ('documents','market_data','browser','compute'))
);
