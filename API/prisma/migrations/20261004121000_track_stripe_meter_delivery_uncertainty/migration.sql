CREATE TYPE "BillingStripeMeterEventState" AS ENUM (
  'PENDING', 'UNCERTAIN', 'ACCEPTED', 'RECONCILIATION_REQUIRED'
);

ALTER TABLE "billing_stripe_usage_exports"
  ADD COLUMN "stripe_meter_event_attempted_at" TIMESTAMP(3),
  ADD COLUMN "stripe_meter_event_state" "BillingStripeMeterEventState" NOT NULL DEFAULT 'PENDING';

UPDATE "billing_stripe_usage_exports"
SET "stripe_meter_event_state" = 'ACCEPTED',
    "stripe_meter_event_attempted_at" = "stripe_meter_event_created_at"
WHERE "stripe_meter_event_created_at" IS NOT NULL;

-- Historic pending rows may already have been accepted remotely. Their first
-- attempt was not recorded, so never replay them automatically after Stripe's
-- identifier uniqueness window may have expired.
UPDATE "billing_stripe_usage_exports"
SET "stripe_meter_event_state" = 'RECONCILIATION_REQUIRED'
WHERE "stripe_meter_event_created_at" IS NULL;

ALTER TABLE "billing_stripe_usage_exports"
  ADD CONSTRAINT "billing_stripe_usage_exports_delivery_state_check" CHECK (
    ("stripe_meter_event_state" = 'ACCEPTED') = ("stripe_meter_event_created_at" IS NOT NULL)
    AND ("stripe_meter_event_state" IN ('UNCERTAIN', 'RECONCILIATION_REQUIRED')
         OR "stripe_meter_event_attempted_at" IS NULL
         OR "stripe_meter_event_state" = 'ACCEPTED')
  );
