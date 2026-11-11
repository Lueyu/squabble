CREATE TABLE IF NOT EXISTS research_dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_library_sources(id),
  source_version_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL, rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, source_version_id, content_hash)
);
CREATE INDEX IF NOT EXISTS research_dataset_owner_idx ON research_dataset_versions(owner, created_at);
CREATE TABLE IF NOT EXISTS research_source_policies (
  source_version_id uuid PRIMARY KEY, owner text NOT NULL,
  data_classes jsonb NOT NULL, permitted_uses jsonb NOT NULL,
  retention_until timestamptz, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS research_artifacts (
  id uuid PRIMARY KEY, owner text NOT NULL, run_id text NOT NULL,
  metadata jsonb NOT NULL, storage_ref text NOT NULL UNIQUE,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_artifact_owner_idx ON research_artifacts(owner, created_at);
CREATE TABLE IF NOT EXISTS research_document_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_library_sources(id),
  source_version_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES data_library_jobs(id),
  original_hash text NOT NULL, extractor text NOT NULL, extractor_version text NOT NULL,
  config_version text NOT NULL, artifact_id uuid NOT NULL REFERENCES research_artifacts(id),
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, job_id)
);
CREATE TABLE IF NOT EXISTS research_document_tasks (
  job_id uuid PRIMARY KEY REFERENCES data_library_jobs(id), owner text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_library_sources(id), source_version_id uuid NOT NULL,
  source_revision integer NOT NULL, source_hash text NOT NULL,
  lease_token uuid NOT NULL, original_hash text NOT NULL,
  extractor text NOT NULL, extractor_version text NOT NULL, config_version text NOT NULL,
  receipt jsonb, state text NOT NULL CHECK (state IN ('submitting','submitted','provider_unknown','cancelled','failed','completed')),
  poll_token uuid, poll_until timestamptz, failure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE research_document_tasks ADD COLUMN IF NOT EXISTS poll_token uuid;
ALTER TABLE research_document_tasks ADD COLUMN IF NOT EXISTS poll_until timestamptz;
ALTER TABLE research_document_tasks ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;
