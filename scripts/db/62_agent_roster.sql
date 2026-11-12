-- Stable owned people, immutable capabilities, explicit private scopes. No records are invented on upgrade.
CREATE TABLE IF NOT EXISTS agent_roster_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 specialty text NOT NULL CHECK(length(specialty) BETWEEN 1 AND 300), description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 current_version_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS agent_roster_profiles_owner_id_idx ON agent_roster_profiles(owner_id,id);
CREATE INDEX IF NOT EXISTS agent_roster_profiles_owner_status_idx ON agent_roster_profiles(owner_id,status,updated_at);
CREATE TABLE IF NOT EXISTS agent_roster_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, agent_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 config_json jsonb NOT NULL CHECK(jsonb_typeof(config_json)='object'), created_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,agent_id) REFERENCES agent_roster_profiles(owner_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS agent_roster_versions_owner_agent_id_idx ON agent_roster_versions(owner_id,agent_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_roster_versions_number_idx ON agent_roster_versions(agent_id,version);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_roster_current_version_fk' AND conrelid='agent_roster_profiles'::regclass) THEN
 ALTER TABLE agent_roster_profiles ADD CONSTRAINT agent_roster_current_version_fk FOREIGN KEY(owner_id,id,current_version_id)
 REFERENCES agent_roster_versions(owner_id,agent_id,id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS agent_roster_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 operation text NOT NULL, input_hash text NOT NULL, result_json jsonb NOT NULL, completed_at timestamptz(3) NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS agent_roster_requests_owner_key_idx ON agent_roster_requests(owner_id,request_key);
CREATE TABLE IF NOT EXISTS agent_roster_memories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, agent_id uuid NOT NULL, scope_json jsonb NOT NULL,
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 16000), origin text NOT NULL CHECK(origin IN ('user_note','source_summary')),
 source_refs_json jsonb NOT NULL CHECK(jsonb_typeof(source_refs_json)='array'), created_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,agent_id) REFERENCES agent_roster_profiles(owner_id,id),
 CHECK((scope_json->>'kind'='personal' AND scope_json='{"kind":"personal"}'::jsonb)
 OR (scope_json->>'kind'='team' AND scope_json ? 'teamId') OR (scope_json->>'kind'='conversation' AND scope_json ? 'conversationId')),
 CHECK(origin<>'source_summary' OR jsonb_array_length(source_refs_json)>0));
CREATE UNIQUE INDEX IF NOT EXISTS agent_roster_memories_owner_id_idx ON agent_roster_memories(owner_id,id);
CREATE INDEX IF NOT EXISTS agent_roster_memories_agent_idx ON agent_roster_memories(owner_id,agent_id,created_at);
CREATE TABLE IF NOT EXISTS agent_roster_memory_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, memory_id uuid NOT NULL, target_agent_id uuid NOT NULL,
 target_scope_json jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,memory_id) REFERENCES agent_roster_memories(owner_id,id),
 FOREIGN KEY(owner_id,target_agent_id) REFERENCES agent_roster_profiles(owner_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS agent_roster_shares_identity_idx ON agent_roster_memory_shares(owner_id,memory_id,target_agent_id,target_scope_json);
CREATE INDEX IF NOT EXISTS agent_roster_shares_target_idx ON agent_roster_memory_shares(owner_id,target_agent_id);
CREATE OR REPLACE FUNCTION agent_roster_prevent_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Agent capability and memory history is immutable'; END $$;
DROP TRIGGER IF EXISTS agent_roster_versions_immutable ON agent_roster_versions;
CREATE TRIGGER agent_roster_versions_immutable BEFORE UPDATE OR DELETE ON agent_roster_versions FOR EACH ROW EXECUTE FUNCTION agent_roster_prevent_snapshot_mutation();
DROP TRIGGER IF EXISTS agent_roster_memories_immutable ON agent_roster_memories;
CREATE TRIGGER agent_roster_memories_immutable BEFORE UPDATE OR DELETE ON agent_roster_memories FOR EACH ROW EXECUTE FUNCTION agent_roster_prevent_snapshot_mutation();
DROP TRIGGER IF EXISTS agent_roster_shares_immutable ON agent_roster_memory_shares;
CREATE TRIGGER agent_roster_shares_immutable BEFORE UPDATE OR DELETE ON agent_roster_memory_shares FOR EACH ROW EXECUTE FUNCTION agent_roster_prevent_snapshot_mutation();
-- Preserve profile names and existing 100-character organization role labels in retained history.
ALTER TABLE council_messages ALTER COLUMN member_name TYPE varchar(100);
