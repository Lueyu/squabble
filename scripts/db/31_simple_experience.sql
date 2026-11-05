CREATE TABLE IF NOT EXISTS experience_preferences (
  owner text PRIMARY KEY, timezone text NOT NULL DEFAULT 'Asia/Shanghai', default_members jsonb NOT NULL DEFAULT '[]',
  default_account_id uuid, migration_state text NOT NULL DEFAULT 'new', enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_current_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner text NOT NULL,topic_key text NOT NULL,date_key text NOT NULL,
  current_document_id uuid REFERENCES research_document_versions(id),generation_key text,generation_sequence integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'empty',task_id uuid,task_kind text,automatic_task_id uuid,error text,change_summary text,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_current_view_identity ON research_current_views(owner,topic_key,date_key);
CREATE TABLE IF NOT EXISTS research_followup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner text NOT NULL,thesis_id uuid NOT NULL,observation_key text NOT NULL,
  due_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'queued',lease_token uuid,lease_until timestamptz,session_id uuid,
  result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_followup_identity ON research_followup_jobs(owner,thesis_id,observation_key);
CREATE INDEX IF NOT EXISTS research_followup_due ON research_followup_jobs(state,due_at);
-- An immutable material reference may never cross the owner's boundary.
CREATE OR REPLACE FUNCTION check_current_research_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_document_versions WHERE id=NEW.current_document_id AND owner=NEW.owner) THEN
    RAISE EXCEPTION 'CURRENT_RESEARCH_OWNER_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS current_research_owner ON research_current_views;
CREATE TRIGGER current_research_owner BEFORE INSERT OR UPDATE ON research_current_views FOR EACH ROW EXECUTE FUNCTION check_current_research_owner();
