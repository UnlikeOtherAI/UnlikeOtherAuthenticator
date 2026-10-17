SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- AlterTable
ALTER TABLE "org_sso_connections" ADD COLUMN     "public_signing_certificates" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "org_revocation_consumers" ADD COLUMN     "acknowledged_at" TIMESTAMP(3),
ADD COLUMN     "failure_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "ready_challenge_expires_at" TIMESTAMP(3),
ADD COLUMN     "ready_challenge_hash" TEXT,
ADD COLUMN     "retention_sequence" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "enterprise_product_readiness" ADD COLUMN     "retention_sequence" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "org_revocation_deliveries" (
    "client_domain" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_revocation_deliveries_pkey" PRIMARY KEY ("client_domain","event_id")
);

ALTER TABLE org_revocation_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_revocation_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_deliveries_deny_app ON org_revocation_deliveries USING (false) WITH CHECK (false);
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE org_revocation_deliveries TO uoa_admin;
  END IF;
END $$;
ALTER TABLE org_revocation_events ADD CONSTRAINT enterprise_event_scope_check CHECK (
  revision > 0 AND (
    (scope = 'user' AND user_id IS NOT NULL AND org_id IS NULL AND team_id IS NULL AND connection_id IS NULL) OR
    (scope IN ('organisation','product_org') AND org_id IS NOT NULL AND team_id IS NULL AND connection_id IS NULL) OR
    (scope = 'team' AND org_id IS NOT NULL AND team_id IS NOT NULL AND connection_id IS NULL) OR
    (scope = 'connection' AND org_id IS NOT NULL AND connection_id IS NOT NULL AND team_id IS NULL)
  )
);
