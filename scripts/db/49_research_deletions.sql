-- Additive owner-scoped tombstones; immutable content, references and ledgers remain intact.
ALTER TABLE IF EXISTS research_document_versions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS council_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS research_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  request_key text NOT NULL, input_hash varchar(64) NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_deletion_requests_owner_key_idx ON research_deletion_requests(owner, request_key);

CREATE OR REPLACE FUNCTION enforce_research_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'RESEARCH_DELETED';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason' - 'deleted_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason' - 'deleted_at') THEN
    RAISE EXCEPTION 'REPORT_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_council_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'RESEARCH_DELETED';
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF to_regclass('council_sessions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS council_tombstone ON council_sessions;
    CREATE TRIGGER council_tombstone BEFORE UPDATE ON council_sessions
      FOR EACH ROW EXECUTE FUNCTION enforce_council_tombstone();
  END IF;
END $$;
