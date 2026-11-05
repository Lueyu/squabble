ALTER TABLE user_api_settings ADD COLUMN IF NOT EXISTS llm_route jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model_route jsonb;
