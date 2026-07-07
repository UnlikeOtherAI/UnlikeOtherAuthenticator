-- Phase 5: shareable team invite links (design §4.7).
-- See Docs/plans/2026-07-07-slack-style-login-and-membership.md (§4.7, §7 step 6, §8).
-- A non-personal, shareable link that authorizes JOINING a team — never authentication. Only the
-- token hash is stored (mirrors domain-secret.service.ts's claim-token pattern); the plaintext
-- token is returned exactly once, at creation. Additive, dormant until the Task 2-5 application
-- code (this same phase) wires create/list/revoke/redeem.

-- CreateTable
CREATE TABLE "team_invite_links" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "role_to_assign" TEXT NOT NULL DEFAULT 'member',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 400,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_invite_links_token_hash_key" ON "team_invite_links"("token_hash");

-- CreateIndex
CREATE INDEX "team_invite_links_team_id_idx" ON "team_invite_links"("team_id");

-- AddForeignKey
ALTER TABLE "team_invite_links" ADD CONSTRAINT "team_invite_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invite_links" ADD CONSTRAINT "team_invite_links_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS for the new table. `team_invite_links` is tenant-scoped exactly like `team_invites`
-- (see 20260423000001_rls_enable_policies): it is written by org routes under the tenant
-- transaction (create/list/revoke, org_id predicate) AND read/updated by the auth routes'
-- BYPASSRLS admin client during redemption (`/auth/select-team`'s `inviteLinkToken` path and the
-- public `/auth/team-invite-link/:token` landing check both run pre-tenant-context, the same way
-- team_invites is read via `request.adminDb` during invite acceptance). Mirroring team_invites'
-- policy shape keeps the two invite mechanisms consistent and is guarded so local/dev without the
-- RLS roles keeps working unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE "team_invite_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_invite_links" FORCE ROW LEVEL SECURITY;

CREATE POLICY team_invite_links_select ON "team_invite_links"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY team_invite_links_insert ON "team_invite_links"
  FOR INSERT TO uoa_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY team_invite_links_update ON "team_invite_links"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));

CREATE POLICY team_invite_links_delete ON "team_invite_links"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

-- Belt-and-braces grants (migration 1's ALTER DEFAULT PRIVILEGES already covers future tables
-- created by the same migrator role, but this makes the table's access explicit regardless of
-- which role ran `prisma migrate deploy`), matching team_invites' own grant in migration 1.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "team_invite_links" TO "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "team_invite_links" TO "uoa_admin";
  END IF;
END
$$;
