-- An explicit count distinguishes a genuinely empty activation roster from missing evidence.
-- The membership and capacity triggers below populate this in the activation transaction.
ALTER TABLE "billing_seat_subscriptions"
  ADD COLUMN "baseline_member_count" INTEGER;
ALTER TABLE "billing_seat_subscriptions"
  ADD CONSTRAINT "billing_seat_baseline_count_nonnegative"
  CHECK ("baseline_member_count" IS NULL OR "baseline_member_count" >= 0);
