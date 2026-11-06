-- Preserve original duplicate evidence before enforcing one current cash row.
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS reconciliation_status varchar(20) NOT NULL DEFAULT 'unconfirmed';
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS confirmed_at timestamptz(3);
CREATE TABLE IF NOT EXISTS cash_account_conflicts (
  id uuid PRIMARY KEY, owner text NOT NULL, currency varchar(10) NOT NULL,
  original jsonb NOT NULL, archived_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cash_balance_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, request_key text NOT NULL,
  input_hash text NOT NULL, changes jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_confirmations_owner_request ON cash_balance_confirmations(owner,request_key);

CREATE TABLE IF NOT EXISTS position_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  ticker varchar(20) NOT NULL, market varchar(10) NOT NULL, currency varchar(10) NOT NULL,
  shares numeric NOT NULL, avg_cost numeric, company text, source text NOT NULL, source_id text,
  observed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  covered_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  covered_closed_ids jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_baselines_owner_ticker ON position_baselines(owner, ticker);
CREATE TABLE IF NOT EXISTS asset_ledger_migrations (
  migration_key text PRIMARY KEY, applied_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Startup replays additive SQL. Only the first upgrade may reinterpret legacy balances/history.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':asset-ledger-upgrade', 0));
  IF NOT EXISTS (SELECT 1 FROM asset_ledger_migrations WHERE migration_key = '37_asset_ledger_integrity') THEN
    WITH duplicates AS (
      SELECT owner, currency FROM cash_accounts GROUP BY owner, currency HAVING count(*) > 1
    )
    INSERT INTO cash_account_conflicts(id, owner, currency, original)
    SELECT c.id, c.owner, c.currency, to_jsonb(c) FROM cash_accounts c
    JOIN duplicates d USING(owner, currency) ON CONFLICT(id) DO NOTHING;
    WITH groups AS (
      SELECT owner, currency, (array_agg(id ORDER BY _created_at, id))[1] AS keep_id,
        count(*) AS n, bool_or(balance <> 0) AS nonzero
      FROM cash_accounts GROUP BY owner, currency
    )
    UPDATE cash_accounts c SET reconciliation_status = CASE
      WHEN c.reconciliation_status = 'review' THEN 'review'
      WHEN g.n > 1 AND g.nonzero THEN 'review'
      WHEN c.balance <> 0 THEN 'confirmed' ELSE c.reconciliation_status END
    FROM groups g WHERE c.id = g.keep_id;
    WITH ranked AS (
      SELECT id, row_number() OVER(PARTITION BY owner, currency ORDER BY _created_at, id) AS n FROM cash_accounts
    )
    DELETE FROM cash_accounts c USING ranked r WHERE c.id = r.id AND r.n > 1;
    UPDATE cash_accounts SET confirmed_at = CURRENT_TIMESTAMP WHERE reconciliation_status = 'confirmed' AND confirmed_at IS NULL;
    -- Existing positions are checkpoints of known state. Historical trades stay untouched.
    INSERT INTO position_baselines(owner,ticker,market,currency,shares,avg_cost,company,source,source_id,covered_transaction_ids,covered_closed_ids)
    SELECT h.owner,h.ticker,coalesce(h.market,'US'),coalesce(h.currency,'USD'),h.shares,h.buy_price,h.company,
      'upgrade-checkpoint',h.id::text,coalesce((SELECT jsonb_agg(t.id::text) FROM transactions t WHERE t.owner=h.owner AND t.ticker=h.ticker),'[]'::jsonb),
      coalesce((SELECT jsonb_agg(c.id::text) FROM closed c WHERE c.owner=h.owner AND c.ticker=h.ticker),'[]'::jsonb)
    FROM holdings h WHERE h.shares > 0 ON CONFLICT(owner,ticker) DO NOTHING;
    INSERT INTO asset_ledger_migrations(migration_key) VALUES ('37_asset_ledger_integrity');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_owner_currency ON cash_accounts(owner, currency);
