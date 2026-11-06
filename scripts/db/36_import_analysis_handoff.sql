CREATE TABLE IF NOT EXISTS research_analysis_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, receipt_id text NOT NULL,
  snapshot jsonb NOT NULL, date_key text NOT NULL, state text NOT NULL DEFAULT 'queued', error text, task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_analysis_request_receipt ON research_analysis_requests(owner,receipt_id);
ALTER TABLE research_current_views ADD COLUMN IF NOT EXISTS dispatch_snapshot jsonb;
ALTER TABLE research_current_views ADD COLUMN IF NOT EXISTS dispatch_route jsonb;
ALTER TABLE research_current_views ADD COLUMN IF NOT EXISTS dispatch_connection_id text;
