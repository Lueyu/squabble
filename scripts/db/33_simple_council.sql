-- Additive, owner-scoped research entry identities and private independent submissions.
CREATE UNIQUE INDEX IF NOT EXISTS council_sessions_owner_id_unique ON council_sessions(owner, id);
CREATE TABLE IF NOT EXISTS simple_council_requests (
  owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simple_council_requests_owner_session_fk FOREIGN KEY(owner, session_id) REFERENCES council_sessions(owner, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS simple_council_requests_owner_key ON simple_council_requests(owner, request_key);
CREATE TABLE IF NOT EXISTS council_independent_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, session_id uuid NOT NULL, cycle_id uuid NOT NULL,
  member_id text NOT NULL, executor_identity jsonb NOT NULL, attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
  contribution jsonb NOT NULL, evidence jsonb NOT NULL, tokens_used integer NOT NULL CHECK(tokens_used >= 0),
  task_id text, external_usage_unknown text, submitted_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  CONSTRAINT council_independent_owner_session_fk FOREIGN KEY(owner, session_id) REFERENCES council_sessions(owner, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS council_independent_submission_unique ON council_independent_submissions(owner, session_id, cycle_id, member_id, attempt);
CREATE OR REPLACE FUNCTION preserve_council_independent_submission() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
    OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'Independent submissions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS council_independent_immutable ON council_independent_submissions;
CREATE TRIGGER council_independent_immutable BEFORE UPDATE ON council_independent_submissions
  FOR EACH ROW EXECUTE FUNCTION preserve_council_independent_submission();
