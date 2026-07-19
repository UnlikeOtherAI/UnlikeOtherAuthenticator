-- Durable, cross-process one-time consumption for chooser login sessions.
-- The raw JWT jti is never persisted; this table receives only its SHA-256 digest.
-- This pre-tenant auth-flow table is available only through the BYPASSRLS admin connection.

CREATE TABLE "login_session_uses" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "jti_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_session_uses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "login_session_uses_domain_jti_hash_key"
  ON "login_session_uses"("domain", "jti_hash");
CREATE INDEX "login_session_uses_expires_at_idx"
  ON "login_session_uses"("expires_at");

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "login_session_uses" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "login_session_uses" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "login_session_uses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "login_session_uses" FORCE ROW LEVEL SECURITY;
CREATE POLICY login_session_uses_deny_app ON "login_session_uses"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
