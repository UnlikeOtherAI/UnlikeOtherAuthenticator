ALTER TABLE account_renewal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_renewal_requests FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE account_renewal_requests FROM uoa_app;
    CREATE POLICY deny_app ON account_renewal_requests FOR ALL TO uoa_app USING (false) WITH CHECK (false);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account_renewal_requests TO uoa_admin;
  END IF;
END $$;
