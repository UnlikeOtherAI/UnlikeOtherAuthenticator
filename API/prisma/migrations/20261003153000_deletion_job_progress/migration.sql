SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE entity_deletion_jobs
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN progress JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_expires_at TIMESTAMP(3);
ALTER TABLE entity_deletion_participants ADD COLUMN retained_evidence JSONB NOT NULL DEFAULT '[]';
CREATE TRIGGER lifecycle_settings BEFORE INSERT OR UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_user_avatars BEFORE INSERT OR UPDATE ON user_avatars FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_team_avatars BEFORE INSERT OR UPDATE ON team_avatars FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_auth_identities BEFORE INSERT OR UPDATE ON auth_identities FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_organisation_owner BEFORE UPDATE OF owner_id ON organisations FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
