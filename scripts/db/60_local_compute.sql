-- Existing receipts retain their original provider. New default selection is application-owned.
ALTER TABLE research_compute_jobs ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'e2b';
ALTER TABLE research_compute_jobs ADD COLUMN IF NOT EXISTS provider_identity jsonb NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='research_compute_provider_check'
    AND conrelid='research_compute_jobs'::regclass) THEN
    ALTER TABLE research_compute_jobs ADD CONSTRAINT research_compute_provider_check
      CHECK(provider IN ('e2b','local-container'));
  END IF;
END $$;
