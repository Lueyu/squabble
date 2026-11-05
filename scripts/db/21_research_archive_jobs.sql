-- Null outcomes are deliberately unknown for historical reports.
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS publication_outcome varchar(10)
  CHECK (publication_outcome IN ('succeeded','failed'));
CREATE TABLE IF NOT EXISTS research_archive_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  report_id uuid NOT NULL, session_id uuid NOT NULL, report_version integer NOT NULL,
  ticker varchar(20) NOT NULL, topic varchar(120) NOT NULL,
  intent varchar(10) NOT NULL CHECK (intent IN ('automatic','manual')),
  state varchar(10) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), error text,
  lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_archive_jobs_report_idx ON research_archive_jobs(owner, report_id, report_version);
CREATE INDEX IF NOT EXISTS research_archive_jobs_due_idx ON research_archive_jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS research_archive_jobs_owner_idx ON research_archive_jobs(owner, id);
