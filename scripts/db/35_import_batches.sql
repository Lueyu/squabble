-- Durable owner-scoped screenshot review; original image bytes remain local for at most 24h.
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY, owner text NOT NULL, revision integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batches_owner_updated ON import_batches(owner,updated_at DESC);
CREATE TABLE IF NOT EXISTS import_commit_receipts (
  id uuid PRIMARY KEY, owner text NOT NULL, batch_id uuid, request_key text NOT NULL,
  input_hash text NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS import_commit_receipt_identity ON import_commit_receipts(owner,request_key);
