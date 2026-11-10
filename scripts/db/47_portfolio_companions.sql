-- Appearance is separate from execution authority. Existing accounts remain
-- unassigned until the owner explicitly chooses their companion.
CREATE TABLE IF NOT EXISTS portfolio_account_companions (
  owner text NOT NULL,
  account_id uuid NOT NULL REFERENCES paper_accounts(id),
  companion_id text NOT NULL CHECK (companion_id IN ('value','growth','risk','technical','news','macro','moderator')),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_account_companion_identity
  ON portfolio_account_companions(owner, account_id);
