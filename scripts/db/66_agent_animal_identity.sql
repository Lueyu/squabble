-- Appearance belongs to the stable person, not immutable capabilities or authorization.
ALTER TABLE agent_roster_profiles ADD COLUMN IF NOT EXISTS avatar text;
UPDATE agent_roster_profiles AS profile
SET avatar = CASE version.config_json->>'templateId'
  WHEN 'financials' THEN 'technical'
  WHEN 'valuation' THEN 'value'
  WHEN 'bear' THEN 'risk'
  WHEN 'risk' THEN 'macro'
  WHEN 'moderator' THEN 'moderator'
  ELSE 'technical'
END
FROM agent_roster_versions AS version
WHERE profile.current_version_id = version.id
  AND profile.owner_id = version.owner_id
  AND profile.id = version.agent_id
  AND profile.avatar IS NULL;
UPDATE agent_roster_profiles SET avatar = 'technical' WHERE avatar IS NULL;
ALTER TABLE agent_roster_profiles ALTER COLUMN avatar SET DEFAULT 'technical';
ALTER TABLE agent_roster_profiles ALTER COLUMN avatar SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_roster_avatar_check' AND conrelid = 'agent_roster_profiles'::regclass
  ) THEN
    ALTER TABLE agent_roster_profiles ADD CONSTRAINT agent_roster_avatar_check
      CHECK (avatar IN ('value', 'growth', 'risk', 'technical', 'news', 'macro', 'moderator'));
  END IF;
END $$;
