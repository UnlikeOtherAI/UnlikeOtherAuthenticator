CREATE TABLE "client_domains" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_domains_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_domain_secrets" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "secret_digest" TEXT NOT NULL,
    "hash_prefix" VARCHAR(16) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMP(3),

    CONSTRAINT "client_domain_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_domains_domain_key" ON "client_domains"("domain");

CREATE INDEX "client_domains_status_idx" ON "client_domains"("status");

CREATE INDEX "client_domain_secrets_domain_id_active_idx" ON "client_domain_secrets"("domain_id", "active");

CREATE UNIQUE INDEX "client_domain_secrets_one_active_idx" ON "client_domain_secrets"("domain_id") WHERE "active" = true;

CREATE INDEX "client_domain_secrets_secret_digest_idx" ON "client_domain_secrets"("secret_digest");

ALTER TABLE "client_domain_secrets" ADD CONSTRAINT "client_domain_secrets_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "client_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
