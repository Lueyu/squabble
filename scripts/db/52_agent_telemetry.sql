-- Owner-scoped operational metadata, independent of private model contents.
CREATE TABLE IF NOT EXISTS telemetry_spans (
  owner text NOT NULL, id text NOT NULL, run_id text NOT NULL, source_id text NOT NULL,
  session_id text, revision integer, scene text NOT NULL, title text NOT NULL,
  parent_id text, kind text NOT NULL CHECK (kind IN ('task','agent','model','tool')),
  name text NOT NULL, status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','unknown')),
  agent_id text, agent_name text, provider text, model text, execution_mode text,
  started_at timestamptz NOT NULL, completed_at timestamptz, duration_ms integer CHECK(duration_ms >= 0),
  input_tokens integer CHECK(input_tokens >= 0), output_tokens integer CHECK(output_tokens >= 0), total_tokens integer CHECK(total_tokens >= 0),
  estimated_cost_usd numeric CHECK(estimated_cost_usd >= 0), error_code text, attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0), trace_id text,
  PRIMARY KEY(owner,id)
);
CREATE INDEX IF NOT EXISTS telemetry_spans_owner_date_idx ON telemetry_spans(owner,started_at);
CREATE INDEX IF NOT EXISTS telemetry_spans_owner_run_idx ON telemetry_spans(owner,run_id);
CREATE TABLE IF NOT EXISTS telemetry_feedback (
  owner text NOT NULL, run_id text NOT NULL, rating text NOT NULL CHECK(rating IN ('positive','negative')),
  comment text NOT NULL DEFAULT '' CHECK(length(comment) <= 2000), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,run_id)
);
