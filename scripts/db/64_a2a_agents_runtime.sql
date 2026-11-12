-- Dedicated A2A authority and receipts. No credentials or remote output in public telemetry.
CREATE TABLE IF NOT EXISTS a2a_agent_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, name text NOT NULL,
 card_url text NOT NULL, secret_enc text, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
 card_hash text NOT NULL, card_name text NOT NULL, card_version text NOT NULL,
 protocol_version text NOT NULL DEFAULT '1.0' CHECK(protocol_version='1.0'), interface_url text NOT NULL, tenant text,
 skills jsonb NOT NULL DEFAULT '[]', capabilities jsonb NOT NULL,
 local_endpoint boolean NOT NULL DEFAULT false, created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS a2a_connections_owner_id_idx ON a2a_agent_connections(owner,id);
CREATE TABLE IF NOT EXISTS a2a_agent_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, request_key text NOT NULL,
 input_hash text NOT NULL, result_json jsonb NOT NULL, completed_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(owner,request_key)
);
CREATE TABLE IF NOT EXISTS a2a_agent_invocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, connection_id uuid NOT NULL,
 message_id text NOT NULL, input_hash text NOT NULL, fingerprint_json jsonb NOT NULL, settlement_secret_enc text,
 remote_task_id text, context_id text,
 state text NOT NULL DEFAULT 'dispatch_intent' CHECK(state IN ('dispatch_intent','dispatch_unknown','submitted','working','completed','failed','cancelled','rejected','input_required','auth_required')),
 acceptance text NOT NULL DEFAULT 'pending' CHECK(acceptance IN ('pending','accepted','invalid','blocked')),
 cancellation text NOT NULL DEFAULT 'none' CHECK(cancellation IN ('none','requested','confirmed','refused','unknown')),
 raw_response_enc text, output_bytes integer NOT NULL DEFAULT 0, failure_code text,
 deadline_at timestamptz NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(owner,connection_id,message_id), FOREIGN KEY(owner,connection_id) REFERENCES a2a_agent_connections(owner,id)
);
CREATE INDEX IF NOT EXISTS a2a_invocations_owner_updated_idx ON a2a_agent_invocations(owner,updated_at,id);
