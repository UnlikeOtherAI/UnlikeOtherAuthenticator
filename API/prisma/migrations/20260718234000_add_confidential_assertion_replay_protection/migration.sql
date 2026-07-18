-- Durable, cross-process one-time consumption for confidential subject assertions.
-- This auth-flow table is available only through the BYPASSRLS admin connection.

CREATE TABLE "confidential_assertion_uses" (
    "id" TEXT NOT NULL,
    "source_domain" TEXT NOT NULL,
    "jti_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confidential_assertion_uses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "confidential_assertion_uses_source_domain_jti_hash_key"
  ON "confidential_assertion_uses"("source_domain", "jti_hash");
CREATE INDEX "confidential_assertion_uses_expires_at_idx"
  ON "confidential_assertion_uses"("expires_at");

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "confidential_assertion_uses" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "confidential_assertion_uses" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "confidential_assertion_uses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "confidential_assertion_uses" FORCE ROW LEVEL SECURITY;
CREATE POLICY confidential_assertion_uses_deny_app ON "confidential_assertion_uses"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
