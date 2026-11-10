CREATE TABLE IF NOT EXISTS data_library_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, kind text NOT NULL,
 title text NOT NULL, description text NOT NULL DEFAULT '', format text NOT NULL, url text,
 file_name text, mime_type text, file_data text, enabled boolean NOT NULL DEFAULT true,
 auth_kind text NOT NULL DEFAULT 'none', secret_enc text, sync_interval_minutes integer,
 next_sync_at timestamptz, latest_version_id uuid, version_count integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending', last_success_at timestamptz, last_error_code text,
 lease_until timestamptz, revision integer NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_library_owner_idx ON data_library_sources(owner, created_at);
CREATE INDEX IF NOT EXISTS data_library_due_idx ON data_library_sources(next_sync_at);
CREATE TABLE IF NOT EXISTS data_library_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
 source_id uuid NOT NULL REFERENCES data_library_sources(id), version integer NOT NULL,
 content_hash text NOT NULL, raw_content text NOT NULL, extracted_text text NOT NULL,
 sections jsonb NOT NULL, byte_length integer NOT NULL, extraction_state text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS data_library_version_idx ON data_library_versions(source_id, version);
CREATE INDEX IF NOT EXISTS data_library_version_owner_idx ON data_library_versions(owner, source_id);
CREATE INDEX IF NOT EXISTS data_library_text_idx ON data_library_versions USING gin(to_tsvector('simple', extracted_text));
CREATE TABLE IF NOT EXISTS data_library_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
 source_id uuid NOT NULL REFERENCES data_library_sources(id), state text NOT NULL,
 outcome text, version_id uuid, error_code text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_library_job_owner_idx ON data_library_jobs(owner, started_at);
CREATE TABLE IF NOT EXISTS financial_data_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, provider text NOT NULL,
 secret_enc text, enabled boolean NOT NULL DEFAULT true, last_test_at timestamptz,
 last_test_ok boolean, last_test_code text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_data_connection_owner_provider_idx ON financial_data_connections(owner, provider);
