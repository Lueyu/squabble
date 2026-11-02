-- Preserve historical A2A reports while new native CLI teams use the local engine.
ALTER TABLE council_reports DROP CONSTRAINT IF EXISTS council_reports_engine_check;
ALTER TABLE council_reports ADD CONSTRAINT council_reports_engine_check
  CHECK (engine IN ('basic', 'llm', 'a2a', 'local', 'mixed'));
