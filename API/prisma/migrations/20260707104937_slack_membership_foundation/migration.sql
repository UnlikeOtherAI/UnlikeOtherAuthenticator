-- Slack-style login & membership — foundation migration.
-- See Docs/plans/2026-07-07-slack-style-login-and-membership.md (§4.1, §4.2, §4.8, §4.10, §11.3).
-- Additive and zero-behaviour-change: every new column has a default matching current behaviour.

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'REMOVED');

-- CreateEnum
CREATE TYPE "TeamJoinPolicy" AS ENUM ('INVITE_ONLY', 'APPROVED_DOMAIN', 'REQUEST_TO_JOIN', 'OPEN_TO_ORG', 'HIDDEN');

-- AlterTable: org_members lifecycle (§4.1)
ALTER TABLE "org_members" ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "status_changed_at" TIMESTAMP(3);

-- AlterTable: organisation workspace icon (§11.3)
ALTER TABLE "organisations" ADD COLUMN     "icon_url" TEXT;

-- AlterTable: team_members lifecycle + guest slot (§4.1, §4.8)
ALTER TABLE "team_members" ADD COLUMN     "is_guest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "status_changed_at" TIMESTAMP(3);

-- AlterTable: team workspace icon + join policy (§11.3, §4.6)
ALTER TABLE "teams" ADD COLUMN     "icon_url" TEXT,
ADD COLUMN     "join_policy" "TeamJoinPolicy" NOT NULL DEFAULT 'INVITE_ONLY';

-- CreateTable: auth identities (§4.2)
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "provider_tenant" TEXT,
    "verified_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable: org-scoped audit log (§4.10)
CREATE TABLE "org_audit_log" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE INDEX "auth_identities_provider_provider_subject_idx" ON "auth_identities"("provider", "provider_subject");

-- CreateIndex
CREATE INDEX "auth_identities_email_idx" ON "auth_identities"("email");

-- CreateIndex: one identity per provider per user (upsert target; safe under per_domain user scope)
CREATE UNIQUE INDEX "auth_identities_user_id_provider_key" ON "auth_identities"("user_id", "provider");

-- CreateIndex
CREATE INDEX "org_audit_log_org_id_created_at_idx" ON "org_audit_log"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "org_audit_log_target_type_target_id_idx" ON "org_audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "org_members_org_id_status_idx" ON "org_members"("org_id", "status");

-- CreateIndex
CREATE INDEX "team_members_team_id_status_idx" ON "team_members"("team_id", "status");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Team-role normalisation: `lead` -> `admin` (api-changes-rebac.md §1, design §4.9).
-- The pre-ReBAC `lead` value is removed; the canonical team roles are owner|admin|member.
-- Data-only backfill; no-op on databases that never wrote `lead`.
-- ---------------------------------------------------------------------------
UPDATE "team_members" SET "team_role" = 'admin' WHERE "team_role" = 'lead';

-- ---------------------------------------------------------------------------
-- Backfill: one `email` auth identity per existing user (design §4.2), verified as of the user's
-- creation time. Records the merge-by-email history that predates this table. `provider_subject` is
-- the user's email; uniqueness is per (user_id, provider), so per_domain duplicate emails on
-- different user rows do not collide. gen_random_uuid() supplies opaque ids (ids are not cuid-shaped
-- but that is invisible to callers). Idempotent via the ON CONFLICT guard.
-- ---------------------------------------------------------------------------
INSERT INTO "auth_identities" ("id", "user_id", "provider", "provider_subject", "email", "verified_at", "created_at")
SELECT gen_random_uuid()::text, u."id", 'email', u."email"::text, u."email", u."created_at", u."created_at"
FROM "users" u
ON CONFLICT ("user_id", "provider") DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS for the two new tables. Both follow the RLS classification in
-- Docs/Requirements/row-level-security.md. The default privileges from
-- 20260423000000_rls_roles_and_grants already grant future tables to uoa_app, so we set explicit
-- policies (and belt-and-braces GRANTs to uoa_admin, which has BYPASSRLS anyway). Guarded so
-- local/dev without the RLS roles keeps working unchanged.
--
--   * auth_identities  — admin-only. Written via the BYPASSRLS admin client during authentication
--     (pre/peri-context, before a stable tenant context exists) and sensitive, so it is locked down
--     for uoa_app exactly like admin_api_keys (20260630120000). deny-all policy as belt-and-braces.
--
--   * org_audit_log    — tenant-scoped. Audit rows are written inside the same tenant transaction as
--     the org/team mutation they record (design §4.10), so uoa_app needs a scoped INSERT bounded to
--     the request's org (app.org_id), plus a matching SELECT for the future org audit-log read
--     endpoint. System writes with no org context (auto-enrolment, later SCIM) go through the
--     BYPASSRLS admin client. No UPDATE/DELETE policy: audit rows are append-only for uoa_app.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "auth_identities" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_identities" TO "uoa_admin";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "org_audit_log" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "auth_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_identities_deny_app ON "auth_identities"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);

ALTER TABLE "org_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_audit_log_insert ON "org_audit_log"
  FOR INSERT TO uoa_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));
CREATE POLICY org_audit_log_select ON "org_audit_log"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));
