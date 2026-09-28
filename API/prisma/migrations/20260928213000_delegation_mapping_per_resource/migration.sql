-- A source product may hold one confidential-delegation mapping per exact
-- target resource, not one in total. Nessie (api.nessie.works / nessie) needs
-- Ledger and DeepCRM, each with its own audited scope allowlist; the old
-- (client_domain_id, product) key let it reach only the first.
--
-- Runs while the previous revision still serves (Docs/deploy.md): bounded so it
-- aborts rather than queueing auth traffic behind a lock. Relaxing a unique key
-- cannot fail on existing rows.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

DROP INDEX "confidential_delegation_mappings_client_domain_id_product_key";

CREATE UNIQUE INDEX "confidential_delegation_mappings_client_domain_id_product_resource_key"
  ON "confidential_delegation_mappings"("client_domain_id", "product", "resource");
