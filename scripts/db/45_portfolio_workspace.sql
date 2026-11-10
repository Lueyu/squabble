-- Historical migrations run on every boot. Retain their index names with
-- compatible account-scoped definitions so they cannot recreate singletons.
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES paper_accounts(id);
UPDATE builder_profiles p SET account_id = m.account_id
FROM strategy_mandates m
JOIN paper_accounts a ON a.id = m.account_id AND a.owner = m.owner AND a.is_active
WHERE p.id = m.profile_id AND p.owner = m.owner AND p.account_id IS NULL
  AND p.version = m.profile_version AND m.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM strategy_mandates other
    JOIN paper_accounts target ON target.id = other.account_id AND target.owner = other.owner AND target.is_active
    WHERE other.owner = p.owner AND other.profile_id = p.id AND other.profile_version = p.version
      AND other.status = 'published' AND other.account_id <> m.account_id
  );
DROP INDEX IF EXISTS paper_accounts_active_owner;
CREATE UNIQUE INDEX paper_accounts_active_owner ON paper_accounts(owner, id) WHERE is_active;
DROP INDEX IF EXISTS idx_builder_profiles_active;
CREATE UNIQUE INDEX idx_builder_profiles_active ON builder_profiles(owner, account_id)
  WHERE status = 'active' AND account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_builder_profiles_active_legacy ON builder_profiles(owner)
  WHERE status = 'active' AND account_id IS NULL;

CREATE TABLE IF NOT EXISTS portfolio_strategy_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id), strategy_id uuid NOT NULL,
  strategy_revision integer NOT NULL, allocation_pct numeric(7,4) NOT NULL CHECK (allocation_pct BETWEEN 0 AND 100),
  enabled boolean NOT NULL, snapshot jsonb NOT NULL, policy_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_assignment_account_strategy
  ON portfolio_strategy_assignments(owner, account_id, strategy_id);
CREATE TABLE IF NOT EXISTS portfolio_combination_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id), policy_revision integer NOT NULL,
  allocations jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_combination_revision
  ON portfolio_combination_revisions(owner, account_id, policy_revision);
CREATE TABLE IF NOT EXISTS portfolio_combination_drafts (
  owner text NOT NULL, account_id uuid NOT NULL REFERENCES paper_accounts(id),
  expected_policy_revision integer NOT NULL, allocations jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_combination_draft_account
  ON portfolio_combination_drafts(owner, account_id);
CREATE TABLE IF NOT EXISTS portfolio_combination_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id), policy_revision integer NOT NULL,
  preview_hash text NOT NULL, allocations jsonb NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Never turn an archived strategy/account back on. Only the live pre-upgrade
-- policy is backfilled, and existing combinations remain authoritative on boot.
INSERT INTO portfolio_strategy_assignments
  (owner, account_id, strategy_id, strategy_revision, allocation_pct, enabled, snapshot, policy_revision)
SELECT p.owner, p.account_id, (p.base_config->'userStrategy'->>'id')::uuid,
  (p.base_config->'userStrategy'->>'revision')::integer, 100, true, p.base_config->'userStrategy', p.revision
FROM investment_policies p JOIN paper_accounts a ON a.id = p.account_id AND a.owner = p.owner
WHERE a.is_active AND p.status <> 'archived' AND p.base_config->'userStrategy'->>'status' = 'confirmed'
  AND NOT (p.base_config ? 'portfolio')
ON CONFLICT (owner, account_id, strategy_id) DO NOTHING;
UPDATE investment_policies p SET
  base_config = jsonb_set(p.base_config, '{portfolio}', assignments.allocations),
  effective_config = jsonb_set(p.effective_config, '{portfolio}', assignments.allocations)
FROM (SELECT owner, account_id, jsonb_agg(jsonb_build_object(
  'strategyId', strategy_id, 'strategyRevision', strategy_revision,
  'allocationPct', allocation_pct, 'enabled', enabled, 'snapshot', snapshot)) AS allocations
  FROM portfolio_strategy_assignments GROUP BY owner, account_id) assignments
WHERE p.owner = assignments.owner AND p.account_id = assignments.account_id
  AND p.status <> 'archived' AND NOT (p.base_config ? 'portfolio');
INSERT INTO portfolio_combination_revisions(owner, account_id, policy_revision, allocations)
SELECT owner, account_id, revision, base_config->'portfolio' FROM investment_policies
WHERE base_config ? 'portfolio' AND status <> 'archived'
ON CONFLICT (owner, account_id, policy_revision) DO NOTHING;
