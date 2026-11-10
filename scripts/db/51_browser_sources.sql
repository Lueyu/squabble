ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'http';
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS browser_state_enc text;
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS browser_connected_at timestamptz;
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE data_library_sources ADD COLUMN IF NOT EXISTS active_job_id uuid;
ALTER TABLE data_library_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE data_library_versions ADD COLUMN IF NOT EXISTS acquisition text NOT NULL DEFAULT 'document';
ALTER TABLE data_library_versions ADD COLUMN IF NOT EXISTS final_url text;
ALTER TABLE data_library_versions ADD COLUMN IF NOT EXISTS page_title text;
UPDATE data_library_versions SET acquisition = 'http'
WHERE acquisition = 'document' AND source_id IN (SELECT id FROM data_library_sources WHERE kind = 'website');
