-- HUGO-539: Admin API keys — terminal/CI control of feature flags & kill switches.

CREATE TABLE "admin_api_keys" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "key_prefix" VARCHAR(24) NOT NULL,
    "secret_digest" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_api_keys_secret_digest_key" ON "admin_api_keys"("secret_digest");

-- Admin-only secret table. The RLS migration 20260423000000_rls_roles_and_grants grants
-- future tables to uoa_app by default, so lock this one down explicitly (matching the
-- other admin-only secret tables in 20260423000001_rls_enable_policies §3).
REVOKE ALL ON TABLE "admin_api_keys" FROM "uoa_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "admin_api_keys" TO "uoa_admin";

-- Belt-and-braces: even if a future migration grants uoa_app a privilege here, the
-- deny-all policy still blocks it. uoa_admin has BYPASSRLS and is unaffected.
ALTER TABLE "admin_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_api_keys_deny_app ON "admin_api_keys"
  FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);
