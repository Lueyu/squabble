CREATE TABLE IF NOT EXISTS council_research_tasks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner TEXT NOT NULL,
 session_id UUID NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
 cycle_id UUID NOT NULL, revision INTEGER NOT NULL, key VARCHAR(20) NOT NULL, position INTEGER NOT NULL,
 member_id TEXT NOT NULL, dependencies JSONB NOT NULL, state VARCHAR(20) NOT NULL DEFAULT 'queued', reason TEXT,
 attempts JSONB NOT NULL DEFAULT '[]'::jsonb, delivery JSONB, skills JSONB NOT NULL,
 reworks INTEGER NOT NULL DEFAULT 0, accepted_attempt_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS council_research_tasks_cycle_key_idx ON council_research_tasks(session_id, cycle_id, key);
CREATE INDEX IF NOT EXISTS council_research_tasks_owner_idx ON council_research_tasks(owner, session_id, cycle_id);
ALTER TABLE council_reports ADD COLUMN IF NOT EXISTS coverage JSONB;
