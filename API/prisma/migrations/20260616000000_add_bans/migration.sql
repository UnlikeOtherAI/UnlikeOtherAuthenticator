-- CreateEnum
CREATE TYPE "BanType" AS ENUM ('EMAIL', 'PATTERN', 'IP', 'USER');

-- CreateTable
CREATE TABLE "bans" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "org_id" TEXT,
    "team_id" TEXT,
    "type" "BanType" NOT NULL,
    "value" VARCHAR(320) NOT NULL,
    "reason" VARCHAR(500),
    "created_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bans_domain_idx" ON "bans"("domain");

-- CreateIndex
CREATE INDEX "bans_org_id_idx" ON "bans"("org_id");

-- CreateIndex
CREATE INDEX "bans_team_id_idx" ON "bans"("team_id");

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: bans are admin-managed and only ever read/written through the BYPASSRLS admin
-- client (login enforcement runs before any tenant context is set, like domain-hash auth
-- against client_domains). Deny the runtime app role entirely. ALTER DEFAULT PRIVILEGES
-- (see 20260423000000_rls_roles_and_grants) auto-grants uoa_app on new tables, so REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "bans" TO uoa_admin;
REVOKE ALL ON "bans" FROM uoa_app;

ALTER TABLE "bans" ENABLE ROW LEVEL SECURITY;

CREATE POLICY bans_deny_app ON "bans"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);
