CREATE TABLE telephone_sms_admissions (
 app_key_id TEXT NOT NULL, message_sid TEXT NOT NULL CHECK(message_sid ~ '^SM[a-f0-9]{32}$'),
 request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('admitted','pending','ambiguous','no_match','invalid','owner_inactive')),
 subject_id TEXT, token_version INTEGER, number_verified_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(app_key_id,message_sid),
 CHECK ((status = 'admitted' AND subject_id IS NOT NULL AND token_version IS NOT NULL AND token_version >= 0 AND number_verified_at IS NOT NULL)
 OR (status <> 'admitted' AND subject_id IS NULL AND token_version IS NULL AND number_verified_at IS NULL))
);
CREATE INDEX telephone_sms_admissions_app_key_id_created_at_idx ON telephone_sms_admissions(app_key_id,created_at);
CREATE INDEX telephone_sms_admissions_subject_id_idx ON telephone_sms_admissions(subject_id);
ALTER TABLE telephone_sms_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephone_sms_admissions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='uoa_app') THEN
  REVOKE ALL ON telephone_sms_admissions FROM uoa_app;
  CREATE POLICY deny_app ON telephone_sms_admissions FOR ALL TO uoa_app USING(false) WITH CHECK(false);
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='uoa_admin') THEN
  GRANT SELECT, INSERT, DELETE ON telephone_sms_admissions TO uoa_admin;
 END IF;
END $$;
CREATE FUNCTION telephone_sms_admission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SMS routing bindings are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER telephone_sms_admission_no_update BEFORE UPDATE ON telephone_sms_admissions
 FOR EACH ROW EXECUTE FUNCTION telephone_sms_admission_immutable();
