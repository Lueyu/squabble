-- Additive owner-scoped research memory. Source references contain no evidence-body snapshots.
CREATE TABLE IF NOT EXISTS research_memory_preferences (
  owner text PRIMARY KEY, auto_archive boolean NOT NULL DEFAULT true, recall_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS research_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  ticker varchar(20) NOT NULL, market varchar(2) NOT NULL CHECK (market IN ('US','HK','CN')),
  topic varchar(120) NOT NULL, language varchar(5) NOT NULL CHECK (language IN ('zh-CN','en')),
  session_id uuid NOT NULL, report_id uuid NOT NULL, report_version integer NOT NULL CHECK (report_version > 0),
  report_revision integer NOT NULL CHECK (report_revision > 0), report_created_at timestamptz NOT NULL,
  summary text NOT NULL, decision varchar(10) NOT NULL CHECK (decision IN ('approve','wait','reject')),
  excluded boolean NOT NULL DEFAULT false, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_memories_report_version_idx ON research_memories(owner, report_id, report_version);
CREATE INDEX IF NOT EXISTS research_memories_owner_symbol_idx ON research_memories(owner, market, ticker);
CREATE TABLE IF NOT EXISTS research_theses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  memory_id uuid NOT NULL REFERENCES research_memories(id), content jsonb NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','dismissed','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), excluded boolean NOT NULL DEFAULT false,
  expires_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_theses_owner_memory_idx ON research_theses(owner, memory_id);
CREATE TABLE IF NOT EXISTS research_thesis_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  thesis_id uuid NOT NULL REFERENCES research_theses(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0), content jsonb NOT NULL,
  status varchar(12) NOT NULL CHECK (status IN ('candidate','confirmed','dismissed','expired')),
  action varchar(12) NOT NULL CHECK (action IN ('candidate','confirm','edit','dismiss','expire','exclude')),
  excluded boolean NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_versions_idx ON research_thesis_versions(owner, thesis_id, version);
