-- Managed accounts need explicit investor strategy authority before resuming.
-- Preserve all ledgers, snapshots, reports and completed trades. Idempotent on upgrade.
UPDATE investment_policies SET status = 'paused', revision = revision + 1, updated_at = NOW()
WHERE status = 'running' AND base_config -> 'userStrategy' IS NULL;
UPDATE paper_accounts a SET bot_enabled = FALSE, updated_at = NOW()
FROM investment_policies p WHERE p.account_id = a.id AND p.owner = a.owner
AND p.status = 'paused' AND p.base_config -> 'userStrategy' IS NULL AND a.bot_enabled = TRUE;
UPDATE investment_cycles c SET state = 'cancelled', updated_at = NOW(), result = jsonb_build_object('reason', 'Confirm an investor strategy before execution')
FROM investment_policies p WHERE p.id = c.policy_id AND p.owner = c.owner AND p.base_config -> 'userStrategy' IS NULL
AND c.state IN ('queued', 'researching', 'waiting');
UPDATE strategy_mandates m SET status = 'paused', updated_at = NOW()
FROM investment_policies p WHERE p.account_id = m.account_id AND p.owner = m.owner AND p.base_config -> 'userStrategy' IS NULL AND m.status = 'published';
UPDATE strategy_reservations r SET status = 'released', reason = 'Confirm an investor strategy before execution', updated_at = NOW()
FROM investment_policies p WHERE p.account_id = r.account_id AND p.owner = r.owner AND p.base_config -> 'userStrategy' IS NULL AND r.status = 'active';
UPDATE strategy_signals s SET state = 'cancelled', reason = 'Confirm an investor strategy before execution', updated_at = NOW()
FROM investment_policies p WHERE p.owner = s.owner AND s.candidate ->> 'accountId' = p.account_id::text
AND p.base_config -> 'userStrategy' IS NULL AND s.state IN ('claimed', 'pending', 'reviewing', 'approved', 'wait');
CREATE TABLE IF NOT EXISTS simulation_valuation_baselines (
  account_id UUID PRIMARY KEY,
  owner TEXT NOT NULL,
  seed JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION reject_simulation_valuation_baseline_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Simulation valuation baseline is immutable'; END;
$$;
DROP TRIGGER IF EXISTS simulation_valuation_baseline_immutable ON simulation_valuation_baselines;
CREATE TRIGGER simulation_valuation_baseline_immutable BEFORE UPDATE OR DELETE ON simulation_valuation_baselines
FOR EACH ROW EXECUTE FUNCTION reject_simulation_valuation_baseline_mutation();

UPDATE paper_orders o SET status = 'cancelled', reason = 'Confirm an investor strategy before execution'
FROM investment_policies p WHERE p.account_id = o.account_id AND p.owner = o.owner
AND p.base_config -> 'userStrategy' IS NULL AND o.status = 'pending_approval';
