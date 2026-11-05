-- Once-per-market-day bounded AI adjustment receipts; pending paid requests are never replayed.
CREATE TABLE IF NOT EXISTS strategy_daily_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  mandate_id uuid NOT NULL, mandate_version integer NOT NULL, mandate_revision integer NOT NULL,
  profile_id uuid NOT NULL, profile_version integer NOT NULL, account_id uuid NOT NULL,
  market text NOT NULL, market_date text NOT NULL, input_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending', input jsonb, output jsonb, rules jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_daily_adjustments_scope_idx
  ON strategy_daily_adjustments(owner, mandate_id, market, market_date);
