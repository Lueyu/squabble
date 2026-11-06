CREATE TABLE IF NOT EXISTS portfolio_value_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, date_key text NOT NULL, slot text NOT NULL,
  captured_at timestamptz NOT NULL, total_value_usd numeric, known_value_usd numeric NOT NULL,
  complete boolean NOT NULL, estimated boolean NOT NULL, external_flows jsonb NOT NULL DEFAULT '[]'::jsonb,
  cash_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb, position_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS cash_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE portfolio_value_points ADD COLUMN IF NOT EXISTS position_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_value_point_slot ON portfolio_value_points(owner,slot);
