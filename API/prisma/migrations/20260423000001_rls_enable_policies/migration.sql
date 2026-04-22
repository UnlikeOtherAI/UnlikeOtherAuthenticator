-- RLS rollout, migration 2 of 2: ENABLE + FORCE RLS and create policies.
-- See Docs/Requirements/row-level-security.md section 7 (classification) and section 8 (M2).
--
-- Prerequisites:
--   * Migration 20260423000000_rls_roles_and_grants applied (creates uoa_app / uoa_admin / uoa_migrator).
--   * The app is running with DATABASE_URL pointing at uoa_app and DATABASE_ADMIN_URL at uoa_admin.
--   * All post-context routes wrap their handler body in runWithTenantContext so `app.domain`,
--     `app.org_id`, and `app.user_id` are set for the duration of the request's transaction.
--
-- Every policy reads NULLIF(current_setting(name, true), '') so a missing GUC returns NULL,
-- which fails the = comparison and denies the row. set_config with an empty string — the shape
-- used by runWithTenantContext when a field is absent — is equivalent to NULL under this wrapping.
--
-- Rollback: `DISABLE ROW LEVEL SECURITY` + `DROP POLICY` for each table below. Reversible.

-- =====================================================================
-- 1. Tenant-scoped tables (org_id predicate)
-- =====================================================================

-- organisations: bootstrap predicate has three branches per plan §7 and §10.11.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisations" FORCE ROW LEVEL SECURITY;

CREATE POLICY organisations_select ON "organisations"
  FOR SELECT TO uoa_app
  USING (
    id = NULLIF(current_setting('app.org_id', true), '')
    OR owner_id = NULLIF(current_setting('app.user_id', true), '')
    OR (
      domain = NULLIF(current_setting('app.domain', true), '')
      AND EXISTS (
        SELECT 1 FROM "org_members" om
        WHERE om.org_id = organisations.id
          AND om.user_id = NULLIF(current_setting('app.user_id', true), '')
      )
    )
  );

CREATE POLICY organisations_insert ON "organisations"
  FOR INSERT TO uoa_app
  WITH CHECK (
    owner_id = NULLIF(current_setting('app.user_id', true), '')
    AND domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY organisations_update ON "organisations"
  FOR UPDATE TO uoa_app
  USING (
    id = NULLIF(current_setting('app.org_id', true), '')
    OR owner_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.org_id', true), '')
    OR owner_id = NULLIF(current_setting('app.user_id', true), '')
  );

CREATE POLICY organisations_delete ON "organisations"
  FOR DELETE TO uoa_app
  USING (
    id = NULLIF(current_setting('app.org_id', true), '')
    OR owner_id = NULLIF(current_setting('app.user_id', true), '')
  );

-- org_members
ALTER TABLE "org_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY org_members_select ON "org_members"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY org_members_insert ON "org_members"
  FOR INSERT TO uoa_app
  WITH CHECK (
    -- Normal case: caller has app.org_id set. Bootstrap case: caller just created
    -- the org in the same transaction and owns it.
    org_id = NULLIF(current_setting('app.org_id', true), '')
    OR EXISTS (
      SELECT 1 FROM "organisations" o
      WHERE o.id = org_members.org_id
        AND o.owner_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY org_members_update ON "org_members"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY org_members_delete ON "org_members"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

-- teams
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;

CREATE POLICY teams_select ON "teams"
  FOR SELECT TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    OR EXISTS (
      SELECT 1 FROM "organisations" o
      WHERE o.id = teams.org_id
        AND o.owner_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY teams_insert ON "teams"
  FOR INSERT TO uoa_app
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    OR EXISTS (
      SELECT 1 FROM "organisations" o
      WHERE o.id = teams.org_id
        AND o.owner_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY teams_update ON "teams"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY teams_delete ON "teams"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

-- team_members: join on teams.org_id
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY team_members_select ON "team_members"
  FOR SELECT TO uoa_app
  USING (
    EXISTS (
      SELECT 1 FROM "teams" t
      WHERE t.id = team_members.team_id
        AND t.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
    OR EXISTS (
      SELECT 1 FROM "teams" t
      JOIN "organisations" o ON o.id = t.org_id
      WHERE t.id = team_members.team_id
        AND o.owner_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY team_members_insert ON "team_members"
  FOR INSERT TO uoa_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "teams" t
      WHERE t.id = team_members.team_id
        AND t.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
    OR EXISTS (
      SELECT 1 FROM "teams" t
      JOIN "organisations" o ON o.id = t.org_id
      WHERE t.id = team_members.team_id
        AND o.owner_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY team_members_update ON "team_members"
  FOR UPDATE TO uoa_app
  USING (
    EXISTS (
      SELECT 1 FROM "teams" t
      WHERE t.id = team_members.team_id
        AND t.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "teams" t
      WHERE t.id = team_members.team_id
        AND t.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  );

CREATE POLICY team_members_delete ON "team_members"
  FOR DELETE TO uoa_app
  USING (
    EXISTS (
      SELECT 1 FROM "teams" t
      WHERE t.id = team_members.team_id
        AND t.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  );

-- team_invites
ALTER TABLE "team_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_invites" FORCE ROW LEVEL SECURITY;

CREATE POLICY team_invites_select ON "team_invites"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY team_invites_insert ON "team_invites"
  FOR INSERT TO uoa_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY team_invites_update ON "team_invites"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY team_invites_delete ON "team_invites"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

-- groups
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "groups" FORCE ROW LEVEL SECURITY;

CREATE POLICY groups_select ON "groups"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY groups_insert ON "groups"
  FOR INSERT TO uoa_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY groups_update ON "groups"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY groups_delete ON "groups"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

-- group_members
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "group_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY group_members_select ON "group_members"
  FOR SELECT TO uoa_app
  USING (
    EXISTS (
      SELECT 1 FROM "groups" g
      WHERE g.id = group_members.group_id
        AND g.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  );

CREATE POLICY group_members_insert ON "group_members"
  FOR INSERT TO uoa_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "groups" g
      WHERE g.id = group_members.group_id
        AND g.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  );

CREATE POLICY group_members_update ON "group_members"
  FOR UPDATE TO uoa_app
  USING (
    EXISTS (
      SELECT 1 FROM "groups" g
      WHERE g.id = group_members.group_id
        AND g.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "groups" g
      WHERE g.id = group_members.group_id
        AND g.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  );

CREATE POLICY group_members_delete ON "group_members"
  FOR DELETE TO uoa_app
  USING (
    EXISTS (
      SELECT 1 FROM "groups" g
      WHERE g.id = group_members.group_id
        AND g.org_id = NULLIF(current_setting('app.org_id', true), '')
    )
  );

-- access_requests
ALTER TABLE "access_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY access_requests_select ON "access_requests"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY access_requests_insert ON "access_requests"
  FOR INSERT TO uoa_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY access_requests_update ON "access_requests"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY access_requests_delete ON "access_requests"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

-- =====================================================================
-- 2. Domain-scoped tables (domain predicate)
-- =====================================================================

-- users: global-scope rows (domain IS NULL) are visible under any tenant context
-- by design (user_scope = global; see plan §7 and §10.12).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON "users"
  FOR SELECT TO uoa_app
  USING (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY users_insert ON "users"
  FOR INSERT TO uoa_app
  WITH CHECK (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY users_update ON "users"
  FOR UPDATE TO uoa_app
  USING (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  )
  WITH CHECK (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY users_delete ON "users"
  FOR DELETE TO uoa_app
  USING (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

-- verification_tokens: mirrors users' nullable-domain shape.
ALTER TABLE "verification_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY verification_tokens_select ON "verification_tokens"
  FOR SELECT TO uoa_app
  USING (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY verification_tokens_insert ON "verification_tokens"
  FOR INSERT TO uoa_app
  WITH CHECK (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY verification_tokens_update ON "verification_tokens"
  FOR UPDATE TO uoa_app
  USING (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  )
  WITH CHECK (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY verification_tokens_delete ON "verification_tokens"
  FOR DELETE TO uoa_app
  USING (
    domain IS NULL
    OR domain = NULLIF(current_setting('app.domain', true), '')
  );

-- authorization_codes
ALTER TABLE "authorization_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authorization_codes" FORCE ROW LEVEL SECURITY;

CREATE POLICY authorization_codes_select ON "authorization_codes"
  FOR SELECT TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY authorization_codes_insert ON "authorization_codes"
  FOR INSERT TO uoa_app
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY authorization_codes_update ON "authorization_codes"
  FOR UPDATE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''))
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY authorization_codes_delete ON "authorization_codes"
  FOR DELETE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

-- refresh_tokens
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY refresh_tokens_select ON "refresh_tokens"
  FOR SELECT TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY refresh_tokens_insert ON "refresh_tokens"
  FOR INSERT TO uoa_app
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY refresh_tokens_update ON "refresh_tokens"
  FOR UPDATE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''))
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY refresh_tokens_delete ON "refresh_tokens"
  FOR DELETE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

-- login_logs
ALTER TABLE "login_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "login_logs" FORCE ROW LEVEL SECURITY;

CREATE POLICY login_logs_select ON "login_logs"
  FOR SELECT TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY login_logs_insert ON "login_logs"
  FOR INSERT TO uoa_app
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY login_logs_update ON "login_logs"
  FOR UPDATE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''))
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY login_logs_delete ON "login_logs"
  FOR DELETE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

-- domain_roles: policy is defense-in-depth. admin-superuser middleware reads this
-- via uoa_admin (BYPASSRLS) because it runs pre-context; the policy protects any
-- future post-context read path.
ALTER TABLE "domain_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_roles" FORCE ROW LEVEL SECURITY;

CREATE POLICY domain_roles_select ON "domain_roles"
  FOR SELECT TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY domain_roles_insert ON "domain_roles"
  FOR INSERT TO uoa_app
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY domain_roles_update ON "domain_roles"
  FOR UPDATE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''))
  WITH CHECK (domain = NULLIF(current_setting('app.domain', true), ''));

CREATE POLICY domain_roles_delete ON "domain_roles"
  FOR DELETE TO uoa_app
  USING (domain = NULLIF(current_setting('app.domain', true), ''));

-- =====================================================================
-- 3. Admin-only tables: ENABLE + FORCE + deny-all policy for uoa_app
-- =====================================================================
-- uoa_admin has BYPASSRLS and is unaffected by these policies. uoa_app already
-- has no privileges on these tables (see M1), but the ENABLE + deny-all policy
-- is belt-and-braces: if a future migration grants uoa_app any privilege here,
-- the policy still denies access until explicitly updated.

ALTER TABLE "client_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY client_domains_deny_app ON "client_domains"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "client_domain_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_domain_secrets" FORCE ROW LEVEL SECURITY;
CREATE POLICY client_domain_secrets_deny_app ON "client_domain_secrets"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "client_domain_jwks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_domain_jwks" FORCE ROW LEVEL SECURITY;
CREATE POLICY client_domain_jwks_deny_app ON "client_domain_jwks"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "client_domain_integration_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_domain_integration_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY client_domain_integration_requests_deny_app ON "client_domain_integration_requests"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "integration_claim_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_claim_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_claim_tokens_deny_app ON "integration_claim_tokens"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_audit_log_deny_app ON "admin_audit_log"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "handshake_error_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "handshake_error_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY handshake_error_logs_deny_app ON "handshake_error_logs"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

-- ai_translations and _prisma_migrations are intentionally excluded (see plan §7).
