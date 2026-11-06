-- Additive strategy authoring workspace. Existing policies, mandates, accounts and orders are preserved.
CREATE TABLE IF NOT EXISTS user_investment_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, revision integer NOT NULL DEFAULT 1,
  parent_id uuid, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')), content jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb, preview jsonb, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_investment_strategies_owner_updated ON user_investment_strategies(owner,updated_at);
CREATE TABLE IF NOT EXISTS user_investment_strategy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  strategy_id uuid NOT NULL REFERENCES user_investment_strategies(id), revision integer NOT NULL, snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_investment_strategy_revision_unique ON user_investment_strategy_revisions(owner,strategy_id,revision);
CREATE TABLE IF NOT EXISTS user_investment_strategy_current (
  owner text PRIMARY KEY, strategy_id uuid NOT NULL REFERENCES user_investment_strategies(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_investment_strategy_preparations (
  owner text NOT NULL, request_key text NOT NULL, strategy_id uuid NOT NULL REFERENCES user_investment_strategies(id),
  input_hash text NOT NULL, status text NOT NULL CHECK (status IN ('pending','succeeded','failed')), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_investment_strategy_preparation_key ON user_investment_strategy_preparations(owner,request_key);
