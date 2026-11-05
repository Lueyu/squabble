-- Additive: existing ledgers retain their USD settlement semantics and all history.
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Paper account';
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS ledger_mode text NOT NULL DEFAULT 'legacy_usd';
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS execution_model jsonb NOT NULL DEFAULT '{"version":"paper-v1","feeBps":0,"slippageBps":0,"corporateActions":"unsupported"}';
ALTER TABLE paper_accounts DROP CONSTRAINT IF EXISTS paper_accounts_owner_unique;
CREATE UNIQUE INDEX IF NOT EXISTS paper_accounts_active_owner ON paper_accounts(owner) WHERE is_active;
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS restricted_shares numeric NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS simulation_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, seed jsonb NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS simulation_seeds (
  account_id uuid PRIMARY KEY REFERENCES paper_accounts(id), owner text NOT NULL,
  preview_id uuid NOT NULL UNIQUE REFERENCES simulation_previews(id), idempotency_key text NOT NULL,
  request_hash text NOT NULL, seed jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_seed_idempotency UNIQUE(owner, idempotency_key)
);
CREATE TABLE IF NOT EXISTS simulation_cash (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES paper_accounts(id),
  owner text NOT NULL, currency text NOT NULL, available numeric NOT NULL DEFAULT 0 CHECK(available >= 0),
  frozen numeric NOT NULL DEFAULT 0 CHECK(frozen >= 0), unsettled numeric NOT NULL DEFAULT 0 CHECK(unsettled >= 0),
  availability_known boolean NOT NULL DEFAULT false,
  CONSTRAINT simulation_cash_account_currency UNIQUE(account_id, currency)
);
CREATE TABLE IF NOT EXISTS simulation_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES paper_accounts(id),
  currency text NOT NULL, amount numeric NOT NULL CHECK(amount >= 0), available_at timestamptz NOT NULL, settled_at timestamptz
);
CREATE OR REPLACE FUNCTION reject_simulation_seed_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Simulation opening seed is immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS simulation_seed_immutable ON simulation_seeds;
CREATE TRIGGER simulation_seed_immutable BEFORE UPDATE OR DELETE ON simulation_seeds
FOR EACH ROW EXECUTE FUNCTION reject_simulation_seed_mutation();

ALTER TABLE paper_snapshots ADD COLUMN IF NOT EXISTS benchmark_equity numeric;
ALTER TABLE paper_snapshots ADD COLUMN IF NOT EXISTS index_benchmark_equity numeric;
-- Unknown historical valuation instants remain null; created_at was not updated on revaluation.
ALTER TABLE paper_snapshots ADD COLUMN IF NOT EXISTS valued_at timestamptz;
