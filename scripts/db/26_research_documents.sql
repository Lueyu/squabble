-- Additive, repeatable immutable research artifact storage. Legacy tables stay intact.
CREATE TABLE IF NOT EXISTS research_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, title text NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('daily','deep','portfolio','council')), ticker varchar(30), source_key text,
  parent_report_id uuid REFERENCES research_documents(id), latest_version_id uuid, adopted_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_documents_source_idx ON research_documents(owner, source_key);
CREATE INDEX IF NOT EXISTS research_documents_owner_idx ON research_documents(owner, created_at);
ALTER TABLE research_documents ADD COLUMN IF NOT EXISTS topic_key text NOT NULL DEFAULT 'portfolio';
UPDATE research_documents SET topic_key = 'ticker:' || upper(trim(ticker)) WHERE ticker IS NOT NULL AND upper(trim(ticker)) <> 'PORTFOLIO' AND topic_key = 'portfolio';
CREATE INDEX IF NOT EXISTS research_documents_topic_idx ON research_documents(owner, topic_key);
CREATE TABLE IF NOT EXISTS research_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, report_id uuid NOT NULL REFERENCES research_documents(id),
  version integer NOT NULL CHECK (version > 0), idempotency_key text NOT NULL, content_hash varchar(64) NOT NULL,
  title text NOT NULL, kind varchar(16) NOT NULL CHECK (kind IN ('daily','deep','portfolio','council')), ticker varchar(30),
  content text NOT NULL, sections jsonb NOT NULL, source jsonb, snapshot jsonb, data_as_of timestamptz, available_at timestamptz,
  parent_version_id uuid REFERENCES research_document_versions(id), change_reason text, revoked_at timestamptz, revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_versions_number_idx ON research_document_versions(report_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS research_versions_key_idx ON research_document_versions(owner, idempotency_key);
CREATE INDEX IF NOT EXISTS research_versions_owner_idx ON research_document_versions(owner, report_id);
CREATE INDEX IF NOT EXISTS research_versions_source_idx ON research_document_versions(owner, (source->>'type'), (source->>'id'));
CREATE TABLE IF NOT EXISTS research_revision_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, report_id uuid NOT NULL REFERENCES research_documents(id),
  parent_version_id uuid NOT NULL REFERENCES research_document_versions(id), revision integer NOT NULL DEFAULT 1,
  title text NOT NULL, content text NOT NULL, sections jsonb NOT NULL, change_reason text NOT NULL,
  published_version_id uuid REFERENCES research_document_versions(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_revision_drafts_owner_idx ON research_revision_drafts(owner, report_id);
CREATE TABLE IF NOT EXISTS research_document_strategy_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, version_id uuid NOT NULL REFERENCES research_document_versions(id),
  strategy_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_document_strategy_use_idx ON research_document_strategy_uses(owner, version_id, strategy_id);
CREATE INDEX IF NOT EXISTS research_document_strategy_owner_idx ON research_document_strategy_uses(owner, version_id);
CREATE TABLE IF NOT EXISTS research_document_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, key text NOT NULL, payload_hash varchar(64) NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_document_submissions_key_idx ON research_document_submissions(owner, key);
CREATE TABLE IF NOT EXISTS research_document_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, report_id uuid NOT NULL REFERENCES research_documents(id),
  version_id uuid NOT NULL REFERENCES research_document_versions(id), previous_version_id uuid REFERENCES research_document_versions(id),
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_document_adoptions_owner_idx ON research_document_adoptions(owner, report_id, created_at);
ALTER TABLE research_revision_drafts ADD COLUMN IF NOT EXISTS source_references jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE OR REPLACE FUNCTION enforce_research_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason') THEN
    RAISE EXCEPTION 'REPORT_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS research_version_immutable ON research_document_versions;
CREATE TRIGGER research_version_immutable BEFORE UPDATE ON research_document_versions FOR EACH ROW EXECUTE FUNCTION enforce_research_version_immutable();
