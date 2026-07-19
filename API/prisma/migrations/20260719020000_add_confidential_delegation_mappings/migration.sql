-- Per-product confidential delegation allowlists. A row is bound to one
-- registered ClientDomain, so callers authenticate with that product's own
-- rotatable domain credential rather than a shared token or process env pair.

CREATE TYPE "ConfidentialDelegationScope" AS ENUM ('ai.invoke', 'billing.read');

CREATE TABLE "confidential_delegation_mappings" (
    "id" TEXT NOT NULL,
    "client_domain_id" TEXT NOT NULL,
    "product" VARCHAR(100) NOT NULL,
    "resource" VARCHAR(2048) NOT NULL,
    "scopes" "ConfidentialDelegationScope"[] NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "updated_by_user_id" TEXT,
    "updated_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "confidential_delegation_mappings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "confidential_delegation_mappings_product_check"
      CHECK ("product" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
    CONSTRAINT "confidential_delegation_mappings_resource_check"
      CHECK (
        "resource" ~ '^https://[^/?#@]+(?:[/?][^#]*)?$'
        AND "resource" !~ '^https://[^/]*@'
      ),
    CONSTRAINT "confidential_delegation_mappings_scopes_check"
      CHECK (
        cardinality("scopes") BETWEEN 1 AND 2
        AND array_position("scopes", NULL) IS NULL
        AND (cardinality("scopes") = 1 OR "scopes"[1] <> "scopes"[2])
      )
);

CREATE UNIQUE INDEX "confidential_delegation_mappings_client_domain_id_product_key"
  ON "confidential_delegation_mappings"("client_domain_id", "product");
CREATE INDEX "confidential_delegation_mappings_product_enabled_idx"
  ON "confidential_delegation_mappings"("product", "enabled");

ALTER TABLE "confidential_delegation_mappings"
  ADD CONSTRAINT "confidential_delegation_mappings_client_domain_id_fkey"
  FOREIGN KEY ("client_domain_id") REFERENCES "client_domains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Mapping state is security-sensitive and is accessed only through the
-- BYPASSRLS admin client (exchange resolution and audited superuser CRUD).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "confidential_delegation_mappings" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "confidential_delegation_mappings" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "confidential_delegation_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "confidential_delegation_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY confidential_delegation_mappings_deny_app
  ON "confidential_delegation_mappings"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
