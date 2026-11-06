-- Additive channel state. Existing accounts, reports and execution ledgers are untouched.
CREATE TABLE IF NOT EXISTS channel_preferences (
 owner text PRIMARY KEY, vibe text NOT NULL DEFAULT 'deskmate' CHECK(vibe IN ('quiet','deskmate','chatty')),
 pinned_bubble_id text, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channel_reports (
 id text NOT NULL, owner text NOT NULL, revision integer NOT NULL, title text NOT NULL, content text NOT NULL,
 section_ids jsonb NOT NULL, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_report_identity ON channel_reports(owner,id,revision);
CREATE TABLE IF NOT EXISTS channel_facts (
 id text NOT NULL, owner text NOT NULL, revision integer NOT NULL, data jsonb NOT NULL, card jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_fact_identity ON channel_facts(owner,id,revision);
CREATE TABLE IF NOT EXISTS channel_episodes (
 id text NOT NULL, owner text NOT NULL, title text NOT NULL, data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_episode_identity ON channel_episodes(owner,id);
CREATE INDEX IF NOT EXISTS channel_episode_owner_updated ON channel_episodes(owner,updated_at);
CREATE TABLE IF NOT EXISTS channel_events (
 id text NOT NULL, owner text NOT NULL, episode_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_event_identity ON channel_events(owner,id);
CREATE INDEX IF NOT EXISTS channel_event_episode ON channel_events(owner,episode_id);
CREATE TABLE IF NOT EXISTS channel_bubbles (
 id text NOT NULL, owner text NOT NULL, episode_id text NOT NULL, semantic_delta_id text NOT NULL, data jsonb NOT NULL,
 resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_bubble_id ON channel_bubbles(owner,id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_bubble_publication ON channel_bubbles(owner,episode_id,semantic_delta_id);
CREATE INDEX IF NOT EXISTS channel_bubble_owner_created ON channel_bubbles(owner,created_at);
CREATE TABLE IF NOT EXISTS channel_outbox (
 id text PRIMARY KEY, owner text NOT NULL, bubble_id text NOT NULL, destination text NOT NULL,
 state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_outbox_delivery ON channel_outbox(bubble_id,destination);
CREATE INDEX IF NOT EXISTS channel_outbox_owner ON channel_outbox(owner,created_at);
CREATE TABLE IF NOT EXISTS channel_findings (
 id text NOT NULL, owner text NOT NULL, data jsonb NOT NULL, seal jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_finding_identity ON channel_findings(owner,id);
CREATE TABLE IF NOT EXISTS channel_briefs (
 id text NOT NULL, owner text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_brief_identity ON channel_briefs(owner,id);
CREATE TABLE IF NOT EXISTS template_registry (
 id text NOT NULL, revision integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS template_registry_identity ON template_registry(id,revision);
CREATE TABLE IF NOT EXISTS channel_supplement_requests (
 id text NOT NULL, owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, message text NOT NULL,
 data jsonb NOT NULL, result jsonb, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((data->>'claimedToolCalls')::integer BETWEEN 0 AND 1), CHECK((data->>'maxToolCalls')::integer=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_supplement_id ON channel_supplement_requests(owner,id);
ALTER TABLE channel_supplement_requests ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS channel_supplement_request ON channel_supplement_requests(owner,request_key);
CREATE TABLE IF NOT EXISTS channel_deferred_questions (
 id text NOT NULL, owner text NOT NULL, request_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_deferred_identity ON channel_deferred_questions(owner,id);
CREATE TABLE IF NOT EXISTS channel_user_actions (
 id text PRIMARY KEY, owner text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL,
 data jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_action_request ON channel_user_actions(owner,request_key);
CREATE TABLE IF NOT EXISTS channel_memories (
 id text NOT NULL, owner text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_memory_identity ON channel_memories(owner,id);
CREATE TABLE IF NOT EXISTS channel_decision_reflections (
 id text NOT NULL, owner text NOT NULL, decision_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_reflection_identity ON channel_decision_reflections(owner,id);
CREATE INDEX IF NOT EXISTS channel_reflection_decision ON channel_decision_reflections(owner,decision_id);
CREATE OR REPLACE FUNCTION channel_assert_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CHANNEL_APPEND_ONLY'; END $$;
DROP TRIGGER IF EXISTS channel_memory_append_only ON channel_memories;
CREATE TRIGGER channel_memory_append_only BEFORE UPDATE OR DELETE ON channel_memories FOR EACH ROW EXECUTE FUNCTION channel_assert_append_only();
DROP TRIGGER IF EXISTS channel_reflection_append_only ON channel_decision_reflections;
CREATE TRIGGER channel_reflection_append_only BEFORE UPDATE OR DELETE ON channel_decision_reflections FOR EACH ROW EXECUTE FUNCTION channel_assert_append_only();
