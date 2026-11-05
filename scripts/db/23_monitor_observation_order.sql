-- Legacy events retain their content and timestamp ordering at sequence zero.
-- New evaluations advance per rule under the owner transaction fence.
ALTER TABLE IF EXISTS research_monitor_events ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS research_monitor_latest_idx ON research_monitor_events(owner, rule_id, sequence DESC, created_at DESC, id DESC);
