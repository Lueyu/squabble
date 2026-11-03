-- Preserve explicit atomic claims; NULL identifies historical reports without structured theses.
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS thesis_candidates JSONB;
-- Workflow acceptance is separate from explicit human confirmation.
ALTER TABLE IF EXISTS research_theses DROP CONSTRAINT IF EXISTS research_theses_status_check;
ALTER TABLE IF EXISTS research_theses ADD CONSTRAINT research_theses_status_check
  CHECK (status IN ('candidate','accepted','confirmed','dismissed','expired'));
ALTER TABLE IF EXISTS research_thesis_versions DROP CONSTRAINT IF EXISTS research_thesis_versions_status_check;
ALTER TABLE IF EXISTS research_thesis_versions ADD CONSTRAINT research_thesis_versions_status_check
  CHECK (status IN ('candidate','accepted','confirmed','dismissed','expired'));
ALTER TABLE IF EXISTS research_thesis_versions DROP CONSTRAINT IF EXISTS research_thesis_versions_action_check;
ALTER TABLE IF EXISTS research_thesis_versions ADD CONSTRAINT research_thesis_versions_action_check
  CHECK (action IN ('candidate','accept','confirm','edit','dismiss','expire','exclude'));
