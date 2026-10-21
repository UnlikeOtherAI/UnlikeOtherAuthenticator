ALTER TABLE telephone_lookups ADD COLUMN admitted_subject_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 ADD COLUMN admitted_token_version INTEGER, ADD COLUMN admitted_number_verified_at TIMESTAMP(3), ADD COLUMN admitted_at TIMESTAMP(3);
ALTER TABLE telephone_lookups ADD CONSTRAINT telephone_admission_shape CHECK (
 (admitted_subject_id IS NULL AND admitted_token_version IS NULL AND admitted_number_verified_at IS NULL AND admitted_at IS NULL)
 OR (admitted_subject_id IS NOT NULL AND admitted_token_version >= 0 AND admitted_number_verified_at IS NOT NULL AND admitted_at IS NOT NULL));
CREATE FUNCTION telephone_admission_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.admitted_subject_id IS NOT NULL AND
   ROW(NEW.admitted_subject_id,NEW.admitted_token_version,NEW.admitted_number_verified_at,NEW.admitted_at,NEW.request_hash,NEW.app_key_id,NEW.call_id)
   IS DISTINCT FROM ROW(OLD.admitted_subject_id,OLD.admitted_token_version,OLD.admitted_number_verified_at,OLD.admitted_at,OLD.request_hash,OLD.app_key_id,OLD.call_id) THEN
   RAISE EXCEPTION 'Telephone call admission cannot rebind' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER telephone_admission_binding BEFORE UPDATE ON telephone_lookups FOR EACH ROW EXECUTE FUNCTION telephone_admission_binding();
