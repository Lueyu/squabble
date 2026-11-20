CREATE INDEX IF NOT EXISTS teams_active_owner_name_idx
  ON teams (owner_id, lower(btrim(name)))
  WHERE status = 'active';
