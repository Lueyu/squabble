-- No implicit LangGraph in-memory persistence or host filesystem is used by the controlled driver.
CREATE TABLE IF NOT EXISTS deep_agent_driver_checkpoints (
  owner text NOT NULL, run_id uuid NOT NULL, context_hash text NOT NULL,
  step_index integer NOT NULL CHECK(step_index BETWEEN 0 AND 5), transcript_enc text NOT NULL,
  transcript_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner,run_id), FOREIGN KEY(owner,run_id) REFERENCES agent_runtime_runs(owner,id)
);
