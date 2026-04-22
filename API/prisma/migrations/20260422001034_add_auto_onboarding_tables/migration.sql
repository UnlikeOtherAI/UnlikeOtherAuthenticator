CREATE TYPE "ClientDomainIntegrationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

CREATE TABLE "client_domain_jwks" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "jwk" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMP(3),
    "created_by_email" TEXT,

    CONSTRAINT "client_domain_jwks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_domain_integration_requests" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "ClientDomainIntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "contact_email" TEXT NOT NULL,
    "public_jwk" JSONB NOT NULL,
    "jwk_fingerprint" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "jwks_url" TEXT NOT NULL,
    "config_url" TEXT,
    "config_summary" JSONB,
    "pre_validation_result" JSONB,
    "decline_reason" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_email" TEXT,
    "client_domain_id" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_domain_integration_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_claim_tokens" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "encrypted_secret" BYTEA,
    "encryption_iv" BYTEA,
    "encryption_tag" BYTEA,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_claim_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_domain" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_domain_jwks_kid_key" ON "client_domain_jwks"("kid");

CREATE INDEX "client_domain_jwks_domain_id_active_idx" ON "client_domain_jwks"("domain_id", "active");

CREATE INDEX "client_domain_integration_requests_status_submitted_at_idx" ON "client_domain_integration_requests"("status", "submitted_at");

CREATE UNIQUE INDEX "integration_claim_tokens_token_hash_key" ON "integration_claim_tokens"("token_hash");

CREATE INDEX "integration_claim_tokens_integration_id_idx" ON "integration_claim_tokens"("integration_id");

CREATE INDEX "admin_audit_log_action_created_at_idx" ON "admin_audit_log"("action", "created_at");

CREATE INDEX "admin_audit_log_target_domain_created_at_idx" ON "admin_audit_log"("target_domain", "created_at");

ALTER TABLE "client_domain_jwks" ADD CONSTRAINT "client_domain_jwks_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "client_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_claim_tokens" ADD CONSTRAINT "integration_claim_tokens_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "client_domain_integration_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "client_domain_integration_request_domain_open_unique"
  ON "client_domain_integration_requests"("domain")
  WHERE status IN ('PENDING', 'DECLINED');
