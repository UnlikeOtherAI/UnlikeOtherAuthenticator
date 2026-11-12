SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE org_creation_operations (
  id CHAR(64) PRIMARY KEY,
  client_domain_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  actor_user_id TEXT,
  operation VARCHAR(16) NOT NULL,
  parent_id TEXT,
  request_hash CHAR(64) NOT NULL,
  result_org_id TEXT NOT NULL,
  result_team_id TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT org_creation_operation_shape CHECK (
    (operation = 'organisation' AND parent_id IS NULL) OR
    (operation = 'team' AND parent_id IS NOT NULL AND parent_id = result_org_id)
  )
);

-- No resource/user FK and no time-based cleanup. A deleted result or identity
-- leaves only the minimal receipt; an old request never creates a replacement.
ALTER TABLE org_creation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_creation_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_creation_operation_scope ON org_creation_operations
  FOR ALL TO uoa_app USING (
    domain = NULLIF(current_setting('app.domain', true), '')
    AND (
      (actor_user_id = NULLIF(current_setting('app.user_id', true), '')
        AND COALESCE(current_setting('app.domain_backend', true), '') <> 'on')
      OR (actor_user_id IS NULL AND current_setting('app.domain_backend', true) = 'on')
    )
  ) WITH CHECK (
    domain = NULLIF(current_setting('app.domain', true), '')
    AND (
      (actor_user_id = NULLIF(current_setting('app.user_id', true), '')
        AND COALESCE(current_setting('app.domain_backend', true), '') <> 'on')
      OR (actor_user_id IS NULL AND current_setting('app.domain_backend', true) = 'on')
    )
  );
REVOKE ALL ON org_creation_operations FROM PUBLIC;
REVOKE UPDATE, DELETE ON org_creation_operations FROM uoa_app;
GRANT SELECT, INSERT ON org_creation_operations TO uoa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_creation_operations TO uoa_admin;

CREATE FUNCTION preserve_org_creation_operation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Organisation creation receipts are immutable';
END;
$$;
CREATE TRIGGER org_creation_operation_immutable
  BEFORE UPDATE OR DELETE ON org_creation_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_org_creation_operation();
