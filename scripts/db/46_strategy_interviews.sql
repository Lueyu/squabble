-- Durable authoring state and idempotent actions; no execution policies are changed.
CREATE TABLE IF NOT EXISTS strategy_interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  account_id uuid NOT NULL,
  base_strategy_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_interviews_owner_account_updated
  ON strategy_interviews(owner, account_id, updated_at);
CREATE TABLE IF NOT EXISTS strategy_interview_requests (
  owner text NOT NULL,
  request_key text NOT NULL,
  input_hash text NOT NULL,
  interview_id uuid NOT NULL REFERENCES strategy_interviews(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_interview_request_owner_key
  ON strategy_interview_requests(owner, request_key);
