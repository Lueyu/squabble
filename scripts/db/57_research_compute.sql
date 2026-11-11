-- Persistent cloud compute intent precedes every sandbox creation. Startup never runs compute.
CREATE TABLE IF NOT EXISTS research_compute_jobs (
  id uuid PRIMARY KEY, owner text NOT NULL, run_id text NOT NULL,
  request_key text NOT NULL, request_hash text NOT NULL, input_enc text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('statistics','backtest','exploratory')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','creating','running','succeeded','failed',
    'provider_unknown','cancel_requested','cancelled')),
  sandbox_id text, termination_confirmed boolean NOT NULL DEFAULT false,
  cancel_requested boolean NOT NULL DEFAULT false, max_runtime_ms integer NOT NULL CHECK(max_runtime_ms BETWEEN 1000 AND 120000),
  result jsonb, error_code text, source_version_ids jsonb NOT NULL DEFAULT '[]', dataset_version_ids jsonb NOT NULL DEFAULT '[]',
  retention_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner,request_key)
);
ALTER TABLE research_compute_jobs ADD COLUMN IF NOT EXISTS source_version_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE research_compute_jobs ADD COLUMN IF NOT EXISTS dataset_version_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE research_compute_jobs ADD COLUMN IF NOT EXISTS retention_until timestamptz;
CREATE INDEX IF NOT EXISTS research_compute_owner_state ON research_compute_jobs(owner,state,created_at);

CREATE OR REPLACE FUNCTION revoke_compute_version_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE research_compute_jobs SET input_enc='', result=NULL, cancel_requested=true,
    state=CASE WHEN state IN ('creating','running','cancel_requested') THEN 'cancel_requested' ELSE 'failed' END,
    error_code='COMPUTE_INPUT_REVOKED', updated_at=now()
    WHERE owner=OLD.owner AND source_version_ids @> jsonb_build_array(OLD.id::text);
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS compute_version_delete_fence ON data_library_versions;
CREATE TRIGGER compute_version_delete_fence BEFORE DELETE ON data_library_versions
  FOR EACH ROW EXECUTE FUNCTION revoke_compute_version_inputs();

CREATE OR REPLACE FUNCTION revoke_compute_source_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE research_compute_jobs j SET input_enc='', result=NULL, cancel_requested=true,
      state=CASE WHEN state IN ('creating','running','cancel_requested') THEN 'cancel_requested' ELSE 'failed' END,
      error_code='COMPUTE_INPUT_REVOKED', updated_at=now()
      WHERE j.owner=NEW.owner AND EXISTS (SELECT 1 FROM data_library_versions v
        WHERE v.owner=NEW.owner AND v.source_id=NEW.id AND j.source_version_ids @> jsonb_build_array(v.id::text));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compute_source_tombstone_fence ON data_library_sources;
CREATE TRIGGER compute_source_tombstone_fence BEFORE UPDATE OF deleted_at ON data_library_sources
  FOR EACH ROW EXECUTE FUNCTION revoke_compute_source_inputs();
