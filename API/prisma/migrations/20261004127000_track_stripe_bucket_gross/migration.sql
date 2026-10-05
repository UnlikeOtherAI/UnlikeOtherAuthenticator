ALTER TABLE "billing_stripe_usage_exports"
  ADD COLUMN "cumulative_gross_meter_quantity" BIGINT;

-- Historical exports did not retain bucket gross. No value can be safely
-- inferred from their net cumulative quantity when prepaid credits existed.
-- Such buckets require an explicit reconciliation before additional exports.
ALTER TABLE "billing_stripe_usage_exports"
  ADD CONSTRAINT "billing_stripe_usage_exports_gross_not_below_net_check"
  CHECK ("cumulative_gross_meter_quantity" IS NULL OR
         "cumulative_gross_meter_quantity" >= "cumulative_meter_quantity");
