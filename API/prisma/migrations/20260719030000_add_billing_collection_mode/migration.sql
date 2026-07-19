CREATE TYPE "BillingCollectionMode" AS ENUM ('STRIPE', 'MANUAL', 'NONE');

ALTER TABLE "billing_tariffs"
  ADD COLUMN "collection_mode" "BillingCollectionMode" NOT NULL DEFAULT 'NONE';

ALTER TABLE "billing_tariffs"
  DROP CONSTRAINT "billing_tariffs_mode_values_check";

ALTER TABLE "billing_tariffs"
  ADD CONSTRAINT "billing_tariffs_mode_values_check" CHECK (
    (
      "mode" = 'FREE'
      AND "markup_bps" = 0
      AND "monthly_amount_minor" = 0
      AND "collection_mode" = 'NONE'
    )
    OR ("mode" = 'AT_COST' AND "markup_bps" = 0)
    OR "mode" IN ('STANDARD', 'CUSTOM')
  );

CREATE OR REPLACE FUNCTION uoa_enforce_billing_tariff_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing tariff versions are immutable';
  END IF;

  IF NEW."service_id" IS DISTINCT FROM OLD."service_id"
    OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."mode" IS DISTINCT FROM OLD."mode"
    OR NEW."collection_mode" IS DISTINCT FROM OLD."collection_mode"
    OR NEW."markup_bps" IS DISTINCT FROM OLD."markup_bps"
    OR NEW."monthly_amount_minor" IS DISTINCT FROM OLD."monthly_amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_by_email" IS DISTINCT FROM OLD."created_by_email"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'billing tariff version terms are immutable';
  END IF;

  RETURN NEW;
END;
$$;
