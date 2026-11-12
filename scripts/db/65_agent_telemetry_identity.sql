-- Nullable frozen identity and trajectory references. Legacy records are not guessed/backfilled.
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS roster_agent_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS roster_agent_version_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS member_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS team_version_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS commission_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS work_key text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS attempt_id text;
ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS configured_model text;
CREATE INDEX IF NOT EXISTS telemetry_spans_owner_agent_version_idx ON telemetry_spans(owner,roster_agent_id,roster_agent_version_id,started_at);
CREATE INDEX IF NOT EXISTS telemetry_spans_owner_commission_idx ON telemetry_spans(owner,commission_id,work_key,attempt_id);
