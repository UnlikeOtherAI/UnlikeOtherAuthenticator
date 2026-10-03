CREATE TABLE "debug_login_grants" (
 "id" TEXT PRIMARY KEY, "token_hash" TEXT NOT NULL UNIQUE,
 "source_family_id" TEXT NOT NULL, "user_id" TEXT NOT NULL,
 "token_version" INTEGER NOT NULL, "domain" TEXT NOT NULL,
 "client_id" TEXT NOT NULL, "config_url" TEXT NOT NULL,
 "org_id" TEXT, "team_id" TEXT, "expires_at" TIMESTAMP(3) NOT NULL,
 "used_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "debug_login_grants_user_id_created_at_idx" ON "debug_login_grants"("user_id", "created_at");
CREATE INDEX "debug_login_grants_expires_at_idx" ON "debug_login_grants"("expires_at");
ALTER TABLE "debug_login_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "debug_login_grants" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
  REVOKE ALL ON TABLE "debug_login_grants" FROM "uoa_app";
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "debug_login_grants" TO "uoa_admin";
 END IF;
END $$;
