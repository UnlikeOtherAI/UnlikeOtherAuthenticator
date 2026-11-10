SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE machine_enrollments (
 id uuid PRIMARY KEY, client_domain text NOT NULL, subject text NOT NULL, audience text NOT NULL,
 org_id text NOT NULL, team_id text NOT NULL, purpose text NOT NULL CHECK(purpose='computer_connection'),
 binding_id text NOT NULL, device_name varchar(100) NOT NULL,
 original_authorization_id uuid NOT NULL, current_authorization_id uuid NOT NULL,
 credential_generation integer NOT NULL DEFAULT 1 CHECK(credential_generation>0),
 source_version bigint NOT NULL DEFAULT 1 CHECK(source_version>0),
 status text NOT NULL DEFAULT 'allowed' CHECK(status IN ('allowed','reauthorization_required','revoked','access_removed')),
 reason text NOT NULL DEFAULT 'active', last_active_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_domain,binding_id)
);
CREATE INDEX machine_enrollments_subject_org_id_team_id_idx ON machine_enrollments(subject,org_id,team_id);
CREATE TABLE machine_authorizations (
 id uuid PRIMARY KEY, enrollment_id uuid NOT NULL REFERENCES machine_enrollments(id) ON DELETE RESTRICT,
 predecessor_id uuid UNIQUE REFERENCES machine_authorizations(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL UNIQUE, consent_hash text NOT NULL, observed_at timestamptz NOT NULL,
 authenticated_at timestamptz, personal_factor_at timestamptz, public_key jsonb NOT NULL, key_thumbprint text NOT NULL,
 credential_epoch integer NOT NULL CHECK(credential_epoch>=0), authentication_evidence_id text NOT NULL,
 legacy_assurance_id text, provenance text NOT NULL CHECK(provenance IN ('independent','sso')),
 methods text[] NOT NULL, personal_factor_completed boolean NOT NULL,
 connection_id text, connection_revision integer, connection_generation integer, external_identity_id text,
 policy_generation integer NOT NULL, consented_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 CHECK(expires_at>consented_at), UNIQUE(enrollment_id,id)
);
ALTER TABLE machine_enrollments ADD CONSTRAINT machine_original_authorization_fk
 FOREIGN KEY(id,original_authorization_id) REFERENCES machine_authorizations(enrollment_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE machine_enrollments ADD CONSTRAINT machine_current_authorization_fk
 FOREIGN KEY(id,current_authorization_id) REFERENCES machine_authorizations(enrollment_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE machine_credentials (
 id uuid PRIMARY KEY, enrollment_id uuid NOT NULL REFERENCES machine_enrollments(id) ON DELETE RESTRICT,
 authorization_id uuid NOT NULL, generation integer NOT NULL CHECK(generation>0), token_hash text NOT NULL UNIQUE,
 operation_id uuid NOT NULL UNIQUE, predecessor_id uuid UNIQUE REFERENCES machine_credentials(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 UNIQUE(enrollment_id,generation), FOREIGN KEY(enrollment_id,authorization_id)
 REFERENCES machine_authorizations(enrollment_id,id) ON DELETE RESTRICT, CHECK(expires_at>created_at)
);
CREATE TABLE machine_authorization_requests (
 id uuid PRIMARY KEY, client_domain text NOT NULL, config_url text NOT NULL, config_fingerprint text NOT NULL, request_hash text NOT NULL,
 binding jsonb NOT NULL, public_key jsonb NOT NULL, key_thumbprint text NOT NULL, device_name varchar(100) NOT NULL,
 enrollment_id uuid, legacy_assurance_id text, challenge text NOT NULL, proof_hash text,
 consented_at timestamptz, denied_at timestamptz, result_enrollment_id uuid,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(consented_at IS NULL OR denied_at IS NULL)
);
CREATE TABLE machine_challenges (
 id uuid PRIMARY KEY, client_domain text NOT NULL, enrollment_id uuid NOT NULL,
 operation_id uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('validate','rotate','revoke','recover')),
 request_hash text NOT NULL, transcript text NOT NULL, proof_hash text, result jsonb,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, UNIQUE(client_domain,operation_id)
);
CREATE TABLE machine_authority_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigserial NOT NULL UNIQUE,
 transaction_id bigint NOT NULL DEFAULT txid_current(), client_domain text NOT NULL,
 enrollment_id uuid NOT NULL REFERENCES machine_enrollments(id) ON DELETE RESTRICT,
 authorization_id uuid NOT NULL, credential_generation integer NOT NULL,
 source_version bigint NOT NULL, status text NOT NULL, reason text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(enrollment_id,source_version)
);
CREATE INDEX machine_authority_events_client_domain_transaction_id_sequence_idx
 ON machine_authority_events(client_domain,transaction_id,sequence);

CREATE FUNCTION machine_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'machine authorization history is immutable'; END $$;
CREATE TRIGGER machine_authorizations_immutable BEFORE UPDATE OR DELETE ON machine_authorizations
 FOR EACH ROW EXECUTE FUNCTION machine_immutable_record();
CREATE TRIGGER machine_credentials_immutable BEFORE UPDATE OR DELETE ON machine_credentials
 FOR EACH ROW EXECUTE FUNCTION machine_immutable_record();
CREATE TRIGGER machine_events_immutable BEFORE UPDATE OR DELETE ON machine_authority_events
 FOR EACH ROW EXECUTE FUNCTION machine_immutable_record();
CREATE FUNCTION machine_enrollment_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'machine grant history is immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.client_domain,NEW.subject,NEW.audience,NEW.org_id,NEW.team_id,NEW.purpose,
    NEW.binding_id,NEW.device_name,NEW.original_authorization_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.client_domain,OLD.subject,OLD.audience,OLD.org_id,OLD.team_id,OLD.purpose,
    OLD.binding_id,OLD.device_name,OLD.original_authorization_id,OLD.created_at)
   THEN RAISE EXCEPTION 'machine grant origin is immutable'; END IF;
  IF ROW(NEW.current_authorization_id,NEW.credential_generation,NEW.status,NEW.reason)
    IS DISTINCT FROM ROW(OLD.current_authorization_id,OLD.credential_generation,OLD.status,OLD.reason) THEN
   IF NEW.source_version<>OLD.source_version+1 THEN RAISE EXCEPTION 'machine source version must advance'; END IF;
  ELSIF NEW.source_version<>OLD.source_version THEN RAISE EXCEPTION 'machine source version without change'; END IF;
  IF NEW.credential_generation<OLD.credential_generation THEN RAISE EXCEPTION 'machine generation cannot regress'; END IF;
  IF OLD.status<>'allowed' AND NEW.status='allowed' AND NEW.current_authorization_id=OLD.current_authorization_id
   THEN RAISE EXCEPTION 'machine authorization cannot revive'; END IF;
  IF OLD.reason IN ('device_revoked','credential_replay','lineage_invalid','all_devices_revoked') AND NEW.status='allowed'
   THEN RAISE EXCEPTION 'retired device requires a new grant'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER machine_enrollment_fence BEFORE UPDATE OR DELETE ON machine_enrollments
 FOR EACH ROW EXECUTE FUNCTION machine_enrollment_fence();
CREATE FUNCTION machine_record_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.source_version<>OLD.source_version THEN
  INSERT INTO machine_authority_events(client_domain,enrollment_id,authorization_id,credential_generation,
    source_version,status,reason) VALUES(NEW.client_domain,NEW.id,NEW.current_authorization_id,
    NEW.credential_generation,NEW.source_version,NEW.status,NEW.reason);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER machine_record_fence AFTER INSERT OR UPDATE ON machine_enrollments
 FOR EACH ROW EXECUTE FUNCTION machine_record_fence();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['machine_enrollments','machine_authorizations','machine_credentials',
   'machine_authorization_requests','machine_challenges','machine_authority_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY machine_admin_only ON %I USING (false) WITH CHECK (false)',tab);
 END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE ON machine_enrollments,machine_authorization_requests,machine_challenges TO uoa_admin;
GRANT SELECT,INSERT ON machine_authorizations,machine_credentials,machine_authority_events TO uoa_admin;
GRANT USAGE,SELECT ON SEQUENCE machine_authority_events_sequence_seq TO uoa_admin;
REVOKE ALL ON machine_enrollments,machine_authorizations,machine_credentials,
 machine_authorization_requests,machine_challenges,machine_authority_events FROM uoa_app;
REVOKE ALL ON FUNCTION machine_immutable_record(),machine_enrollment_fence(),machine_record_fence() FROM PUBLIC;

CREATE TABLE machine_browser_sessions (
 id uuid PRIMARY KEY, subject text NOT NULL, client_domain text NOT NULL,
 config_url text NOT NULL, config_fingerprint text NOT NULL, org_id text NOT NULL, team_id text NOT NULL,
 request_id uuid, evidence_id text NOT NULL, credential_epoch integer NOT NULL,
 browser_hash text NOT NULL, authenticated_at timestamptz, finalized_at timestamptz, expires_at timestamptz NOT NULL
);
ALTER TABLE machine_browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_browser_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY machine_admin_only ON machine_browser_sessions USING(false) WITH CHECK(false);
GRANT SELECT,INSERT,UPDATE,DELETE ON machine_browser_sessions TO uoa_admin;
REVOKE ALL ON machine_browser_sessions FROM uoa_app;
ALTER TABLE signing_continuations ADD COLUMN machine_intent_id uuid;

ALTER TABLE org_revocation_consumers
 ADD COLUMN machine_capability_version integer NOT NULL DEFAULT 0,
 ADD COLUMN machine_cursor text,
 ADD COLUMN machine_ready_challenge_hash text,
 ADD COLUMN machine_ready_expires_at timestamptz,
 ADD COLUMN machine_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN machine_failure_count integer NOT NULL DEFAULT 0;

CREATE FUNCTION machine_authorization_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root machine_enrollments; parent machine_authorizations;
BEGIN
 SELECT * INTO STRICT root FROM machine_enrollments WHERE id=NEW.enrollment_id FOR UPDATE;
 IF NEW.predecessor_id IS NULL THEN
  IF root.original_authorization_id<>NEW.id OR root.current_authorization_id<>NEW.id THEN
   RAISE EXCEPTION 'machine original authorization mismatch'; END IF;
 ELSE
  SELECT * INTO STRICT parent FROM machine_authorizations WHERE id=NEW.predecessor_id;
  IF parent.enrollment_id<>NEW.enrollment_id OR root.current_authorization_id<>parent.id
    OR parent.key_thumbprint<>NEW.key_thumbprint OR parent.public_key<>NEW.public_key THEN
   RAISE EXCEPTION 'machine authorization lineage mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER machine_authorization_lineage BEFORE INSERT ON machine_authorizations
 FOR EACH ROW EXECUTE FUNCTION machine_authorization_lineage();
CREATE FUNCTION machine_credential_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root machine_enrollments; auth machine_authorizations; parent machine_credentials;
BEGIN
 SELECT * INTO STRICT root FROM machine_enrollments WHERE id=NEW.enrollment_id FOR UPDATE;
 SELECT * INTO STRICT auth FROM machine_authorizations WHERE id=NEW.authorization_id;
 IF auth.enrollment_id<>NEW.enrollment_id OR NEW.expires_at>auth.expires_at THEN
  RAISE EXCEPTION 'machine credential authority mismatch'; END IF;
 IF NEW.predecessor_id IS NULL THEN
  IF NEW.operation_id<>auth.request_id OR
    NOT ((root.original_authorization_id=auth.id AND NEW.generation=1 AND root.credential_generation=1)
     OR (auth.predecessor_id=root.current_authorization_id AND NEW.generation=root.credential_generation+1)) THEN
   RAISE EXCEPTION 'machine credential origin mismatch'; END IF;
 ELSE
  SELECT * INTO STRICT parent FROM machine_credentials WHERE id=NEW.predecessor_id;
  IF parent.enrollment_id<>NEW.enrollment_id OR parent.authorization_id<>NEW.authorization_id
    OR parent.generation+1<>NEW.generation OR root.current_authorization_id<>NEW.authorization_id
    OR root.credential_generation+1<>NEW.generation THEN
   RAISE EXCEPTION 'machine credential lineage mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER machine_credential_lineage BEFORE INSERT ON machine_credentials
 FOR EACH ROW EXECUTE FUNCTION machine_credential_lineage();
REVOKE ALL ON FUNCTION machine_authorization_lineage(),machine_credential_lineage() FROM PUBLIC;

CREATE FUNCTION machine_request_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.consented_at IS NOT NULL OR OLD.denied_at IS NOT NULL THEN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'machine consent request is immutable'; END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.client_domain,NEW.config_url,NEW.config_fingerprint,NEW.request_hash,NEW.binding,
   NEW.public_key,NEW.key_thumbprint,NEW.device_name,NEW.enrollment_id,NEW.legacy_assurance_id,NEW.challenge,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.client_domain,OLD.config_url,OLD.config_fingerprint,OLD.request_hash,OLD.binding,
   OLD.public_key,OLD.key_thumbprint,OLD.device_name,OLD.enrollment_id,OLD.legacy_assurance_id,OLD.challenge,OLD.expires_at,OLD.created_at)
   OR (OLD.proof_hash IS NOT NULL AND NEW.proof_hash IS DISTINCT FROM OLD.proof_hash) THEN
   RAISE EXCEPTION 'machine request binding is immutable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER machine_request_history BEFORE UPDATE OR DELETE ON machine_authorization_requests
 FOR EACH ROW EXECUTE FUNCTION machine_request_history();
CREATE FUNCTION machine_challenge_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.client_domain,NEW.enrollment_id,NEW.operation_id,NEW.operation,NEW.request_hash,NEW.transcript,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.client_domain,OLD.enrollment_id,OLD.operation_id,OLD.operation,OLD.request_hash,OLD.transcript,OLD.expires_at)
  OR (OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'machine challenge binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER machine_challenge_history BEFORE UPDATE ON machine_challenges
 FOR EACH ROW EXECUTE FUNCTION machine_challenge_history();
REVOKE ALL ON FUNCTION machine_request_history(),machine_challenge_history() FROM PUBLIC;
