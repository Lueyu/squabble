-- Additive execution metadata. Existing running work is never replayed by migration.
ALTER TABLE experience_preferences ADD COLUMN IF NOT EXISTS member_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS council_member_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, session_id uuid NOT NULL, cycle_id uuid NOT NULL,
  member_id text NOT NULL, attempt integer NOT NULL CHECK(attempt > 0), revision integer NOT NULL, turn integer NOT NULL,
  resource_key text NOT NULL, input_hash text NOT NULL, input_snapshot jsonb NOT NULL, message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id text, dispatch_started boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'queued', result_acceptance text NOT NULL DEFAULT 'pending',
  raw_text text, tokens_used integer NOT NULL DEFAULT 0 CHECK(tokens_used >= 0), failure jsonb, failure_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner, session_id) REFERENCES council_sessions(owner, id) ON DELETE CASCADE,
  CHECK(status IN ('queued','running','completed','failed','cancelled','unknown','skipped')),
  CHECK(result_acceptance IN ('pending','accepted','rejected'))
);
ALTER TABLE council_member_attempts ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS council_member_attempt_identity ON council_member_attempts(owner,session_id,cycle_id,member_id,attempt);
CREATE INDEX IF NOT EXISTS council_member_attempt_active ON council_member_attempts(owner,session_id,cycle_id,status);
CREATE TABLE IF NOT EXISTS council_recovery_requests (
  owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, session_id uuid NOT NULL,
  member_id text NOT NULL, attempt_id uuid, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner,session_id) REFERENCES council_sessions(owner,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS council_recovery_owner_request ON council_recovery_requests(owner,request_key);
