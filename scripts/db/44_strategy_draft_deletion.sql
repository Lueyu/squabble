-- Keep deleted draft revisions and model-dispatch receipts for audit and deduplication.
ALTER TABLE user_investment_strategies ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
