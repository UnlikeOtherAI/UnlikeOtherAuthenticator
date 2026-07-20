CREATE TYPE "BillingAppKeyPurpose" AS ENUM (
  'ENTITLEMENT',
  'CUSTOMER_LIFECYCLE'
);

ALTER TABLE "billing_app_keys"
  ADD COLUMN "purpose" "BillingAppKeyPurpose" NOT NULL DEFAULT 'ENTITLEMENT';

UPDATE "billing_app_keys"
SET "purpose" = 'CUSTOMER_LIFECYCLE'
WHERE cardinality("checkout_return_origins") > 0;

ALTER TABLE "billing_app_keys"
  ADD CONSTRAINT "billing_app_keys_purpose_origins_check"
  CHECK (
    (
      "purpose" = 'ENTITLEMENT'
      AND cardinality("checkout_return_origins") = 0
    )
    OR (
      "purpose" = 'CUSTOMER_LIFECYCLE'
      AND cardinality("checkout_return_origins") > 0
    )
  );

CREATE INDEX "billing_app_keys_service_id_purpose_idx"
  ON "billing_app_keys"("service_id", "purpose");
