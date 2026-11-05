-- Additive scene and immutable branch context; legacy stock rooms retain their identity.
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS scene varchar(24) NOT NULL DEFAULT 'stock';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT '';
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS period jsonb;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS parent_session_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS parent_message_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS parent_report_id uuid;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS report_references jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS resolved_references jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS inherited_context jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS research_version_id uuid;
UPDATE council_sessions SET title = ticker WHERE title = '';
UPDATE council_sessions SET subject = ticker WHERE subject = '';
CREATE INDEX IF NOT EXISTS council_sessions_parent_idx ON council_sessions(owner, parent_session_id);

ALTER TABLE council_sessions ADD COLUMN IF NOT EXISTS continuation_summary jsonb;
CREATE TABLE IF NOT EXISTS council_revision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  request_key uuid NOT NULL, input_hash varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending', result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner, request_key)
);
