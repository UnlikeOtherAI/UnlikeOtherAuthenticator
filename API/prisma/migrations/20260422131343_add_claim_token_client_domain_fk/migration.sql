-- Rotation claim tokens need to know which ClientDomain they rotate so the
-- consume step can install the new secret + deactivate the old one atomically.
-- For initial accept claims this column stays NULL (no rotation semantics).

ALTER TABLE "integration_claim_tokens" ADD COLUMN "client_domain_id" TEXT;

ALTER TABLE "integration_claim_tokens"
  ADD CONSTRAINT "integration_claim_tokens_client_domain_id_fkey"
  FOREIGN KEY ("client_domain_id") REFERENCES "client_domains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "integration_claim_tokens_client_domain_id_idx"
  ON "integration_claim_tokens"("client_domain_id");
