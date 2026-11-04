-- Rules are versioned, and breach events are immutable across later observations.
CREATE TABLE IF NOT EXISTS research_monitor_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, root_id uuid NOT NULL,
  thesis_id uuid NOT NULL, thesis_version integer NOT NULL, version integer NOT NULL,
  ticker text NOT NULL, market text NOT NULL, origin text NOT NULL, report_id uuid NOT NULL, report_version integer NOT NULL,
  condition jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_rule_version_idx ON research_monitor_rules(owner, root_id, version);
CREATE INDEX IF NOT EXISTS research_monitor_thesis_idx ON research_monitor_rules(owner, thesis_id, thesis_version);
CREATE TABLE IF NOT EXISTS research_monitor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, rule_id uuid NOT NULL, rule_version integer NOT NULL,
  thesis_id uuid NOT NULL, thesis_version integer NOT NULL, observation_key text NOT NULL, observation jsonb NOT NULL,
  state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_observation_idx ON research_monitor_events(owner, rule_id, rule_version, thesis_version, observation_key);
CREATE INDEX IF NOT EXISTS research_monitor_breach_idx ON research_monitor_events(owner, thesis_id, thesis_version, state);
CREATE TABLE IF NOT EXISTS research_thesis_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, thesis_id uuid NOT NULL, thesis_version integer NOT NULL,
  previous_id uuid NOT NULL, previous_version integer NOT NULL, reason text NOT NULL,
  cycle_id uuid NOT NULL, task_id uuid NOT NULL, attempt_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_replacement_idx ON research_thesis_replacements(owner, thesis_id, thesis_version);
-- NULL preserves unknown legacy dependency state until a fresh validated plan is captured.
ALTER TABLE IF EXISTS strategy_plans ADD COLUMN IF NOT EXISTS memory_inventory jsonb;

CREATE TABLE IF NOT EXISTS research_memory_preferences (owner text PRIMARY KEY, auto_archive boolean NOT NULL DEFAULT true, recall_enabled boolean NOT NULL DEFAULT true);
ALTER TABLE research_monitor_rules DROP CONSTRAINT IF EXISTS research_monitor_rules_report_fk;
ALTER TABLE research_monitor_rules ADD CONSTRAINT research_monitor_rules_report_fk FOREIGN KEY (report_id) REFERENCES council_reports(id) ON DELETE CASCADE;
