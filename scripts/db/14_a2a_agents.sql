ALTER TABLE council_reports DROP CONSTRAINT IF EXISTS council_reports_engine_check;
ALTER TABLE council_reports ADD CONSTRAINT council_reports_engine_check CHECK (engine IN ('basic','llm','a2a','local','mixed'));
