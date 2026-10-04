ALTER TABLE "billing_stripe_usage_exports"
  ADD COLUMN "stripe_meter_event_first_attempted_at" TIMESTAMP(3),
  ADD COLUMN "stripe_meter_event_attempt_generation" INTEGER NOT NULL DEFAULT 0;

UPDATE "billing_stripe_usage_exports"
SET "stripe_meter_event_first_attempted_at" = "stripe_meter_event_attempted_at"
WHERE "stripe_meter_event_attempted_at" IS NOT NULL;

ALTER TABLE "billing_stripe_usage_exports"
  ADD CONSTRAINT "billing_stripe_usage_exports_attempt_generation_check"
  CHECK ("stripe_meter_event_attempt_generation" >= 0 AND
         ("stripe_meter_event_attempted_at" IS NULL OR
          "stripe_meter_event_first_attempted_at" IS NOT NULL));
