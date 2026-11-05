-- Additive provenance metadata. Existing values remain unknown and existing opinions are not rewritten.
ALTER TABLE agent_evidence ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE research_thesis_versions ADD COLUMN IF NOT EXISTS change_reason text;
CREATE TABLE IF NOT EXISTS research_memory_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  memory_id uuid NOT NULL REFERENCES research_memories(id),
  report_id uuid NOT NULL REFERENCES council_reports(id) ON DELETE CASCADE,
  report_version integer NOT NULL, report_revision integer NOT NULL, evidence_id text NOT NULL,
  metadata jsonb NOT NULL, ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_memory_evidence_identity_idx
  ON research_memory_evidence(owner, report_id, report_version, report_revision, evidence_id);
CREATE INDEX IF NOT EXISTS research_memory_evidence_memory_idx ON research_memory_evidence(owner, memory_id);
CREATE TABLE IF NOT EXISTS research_thesis_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
  version_id uuid NOT NULL REFERENCES research_thesis_versions(id) ON DELETE CASCADE,
  evidence_record_id uuid NOT NULL REFERENCES research_memory_evidence(id) ON DELETE CASCADE,
  role varchar(8) NOT NULL CHECK (role IN ('support','refute','qualify'))
);
CREATE UNIQUE INDEX IF NOT EXISTS research_thesis_evidence_identity_idx
  ON research_thesis_evidence(owner, version_id, evidence_record_id, role);
