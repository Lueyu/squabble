-- Bounded owner-scoped investment council. Run with ON_ERROR_STOP.
CREATE TABLE IF NOT EXISTS council_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  profile_id uuid NOT NULL REFERENCES builder_profiles(id), profile_version integer NOT NULL CHECK (profile_version > 0),
  profile_snapshot jsonb NOT NULL, ticker varchar(20) NOT NULL,
  language varchar(5) NOT NULL DEFAULT 'zh-CN' CHECK (language IN ('zh-CN','en')),
  status varchar(16) NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','completed','paused','failed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), task_id uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate jsonb, evidence_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb, source_run_id uuid,
  cache_key varchar(64), error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_sessions_owner_created_idx ON council_sessions(owner, created_at);
CREATE INDEX IF NOT EXISTS council_sessions_cache_idx ON council_sessions(owner, cache_key, created_at);
CREATE TABLE IF NOT EXISTS council_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('researcher','challenger','manager','user','system')),
  member_name varchar(40) NOT NULL, content text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  tokens_used integer NOT NULL DEFAULT 0 CHECK (tokens_used >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_messages_session_idx ON council_messages(owner, session_id, created_at);
CREATE TABLE IF NOT EXISTS council_reports (
  publication_outcome varchar(10) CHECK (publication_outcome IN ('succeeded','failed')),
  thesis_candidates JSONB,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0), revision integer NOT NULL CHECK (revision > 0),
  decision varchar(10) NOT NULL CHECK (decision IN ('approve','wait','reject')),
  summary text NOT NULL, dissent jsonb NOT NULL, next_review_condition text NOT NULL,
  evidence jsonb NOT NULL, source_run_id uuid, candidate jsonb, paper_order_id uuid REFERENCES paper_orders(id),
  tokens_used integer NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  engine varchar(10) NOT NULL CHECK (engine IN ('basic','llm')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS council_reports_version_idx ON council_reports(session_id, version);
CREATE INDEX IF NOT EXISTS council_reports_owner_idx ON council_reports(owner, session_id, created_at);

