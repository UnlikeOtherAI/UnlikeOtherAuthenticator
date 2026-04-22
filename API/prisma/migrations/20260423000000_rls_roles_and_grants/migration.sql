-- RLS rollout, migration 1 of 2: create roles and grants. No policies enabled here.
-- See Docs/Requirements/row-level-security.md section 8 (M1).

-- 1. Roles.
-- uoa_app is the runtime role for post-context requests. Must NOT have BYPASSRLS.
-- uoa_admin is the bootstrap role for pre-context and admin DB paths. HAS BYPASSRLS.
-- uoa_migrator is reserved for future schema migrations; not used at runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    CREATE ROLE uoa_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    CREATE ROLE uoa_admin NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE uoa_admin BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_migrator') THEN
    CREATE ROLE uoa_migrator NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE uoa_migrator BYPASSRLS;
  END IF;
END
$$;

-- 2. Schema-level access.
GRANT USAGE ON SCHEMA public TO uoa_app, uoa_admin, uoa_migrator;

-- 3. Table-level privileges for tenant-scoped and domain-scoped tables.
-- uoa_app gets SELECT/INSERT/UPDATE/DELETE; uoa_admin gets everything.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "organisations",
  "org_members",
  "teams",
  "team_members",
  "team_invites",
  "groups",
  "group_members",
  "access_requests",
  "users",
  "verification_tokens",
  "authorization_codes",
  "refresh_tokens",
  "login_logs",
  "domain_roles",
  "ai_translations"
TO uoa_app, uoa_admin;

-- 4. Admin-only tables: uoa_admin full access, uoa_app REVOKEd.
-- client_domains and client_domain_secrets are read pre-context by domain-hash auth, so app role
-- must not access them directly. handshake_error_logs is written from config-verifier failure
-- paths before the caller's domain is verified.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "client_domains",
  "client_domain_secrets",
  "client_domain_jwks",
  "client_domain_integration_requests",
  "integration_claim_tokens",
  "admin_audit_log",
  "handshake_error_logs"
TO uoa_admin;

REVOKE ALL ON
  "client_domains",
  "client_domain_secrets",
  "client_domain_jwks",
  "client_domain_integration_requests",
  "integration_claim_tokens",
  "admin_audit_log",
  "handshake_error_logs"
FROM uoa_app;

-- 5. Sequences (Prisma uses cuid() not sequences for most tables, but grant defensively).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uoa_app, uoa_admin;

-- 6. Default privileges so future tables created by the current migrator role inherit these grants
-- automatically. If this migration is run under a different role, the block is harmless.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uoa_app, uoa_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO uoa_app, uoa_admin;
