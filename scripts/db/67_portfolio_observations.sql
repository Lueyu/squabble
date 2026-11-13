-- Additive facts only. No historical minute points are reconstructed from daily rows.
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS market_quotes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS source_fingerprint text;
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS gaps jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS paper_equity_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, account_id uuid NOT NULL,
  slot text NOT NULL, date_key text NOT NULL, captured_at timestamptz NOT NULL,
  equity_usd numeric, known_value_usd numeric NOT NULL, complete boolean NOT NULL, estimated boolean NOT NULL,
  market_quotes jsonb NOT NULL DEFAULT '[]'::jsonb, gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_fingerprint text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS paper_equity_observation_slot ON paper_equity_observations(owner, account_id, slot);
CREATE INDEX IF NOT EXISTS paper_equity_observation_time ON paper_equity_observations(owner, account_id, captured_at);
CREATE TABLE IF NOT EXISTS portfolio_valuation_claims (
  owner text NOT NULL, account_key text NOT NULL, slot text NOT NULL, token uuid NOT NULL,
  lease_until timestamptz NOT NULL, completed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_valuation_claim_slot ON portfolio_valuation_claims(owner, account_key, slot);
