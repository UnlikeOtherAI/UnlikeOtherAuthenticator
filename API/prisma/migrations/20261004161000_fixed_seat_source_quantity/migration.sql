ALTER TABLE "billing_stripe_checkout_sessions"
  ADD COLUMN "fixed_seat_quantity" INTEGER,
  ADD CONSTRAINT "billing_stripe_checkout_fixed_quantity_check"
    CHECK ("fixed_seat_quantity" IS NULL OR "fixed_seat_quantity" > 0);

ALTER TABLE "billing_contract_service_terms"
  ADD COLUMN "fixed_seat_quantity" INTEGER,
  ADD CONSTRAINT "billing_contract_term_fixed_quantity_check"
    CHECK ("fixed_seat_quantity" IS NULL OR "fixed_seat_quantity" > 0);

-- The roster is captured when a future manual agreement is scheduled; the
-- commercial month can start later without inventing a historical baseline.
ALTER TABLE "billing_seat_subscriptions"
  ADD COLUMN "commercial_effective_at" TIMESTAMP(3),
  ADD COLUMN "commercial_ends_at" TIMESTAMP(3);
UPDATE "billing_seat_subscriptions"
  SET "commercial_effective_at" = "activated_at";
ALTER TABLE "billing_seat_subscriptions"
  ALTER COLUMN "commercial_effective_at" SET NOT NULL,
  ADD CONSTRAINT "billing_seat_commercial_interval_check" CHECK (
    "commercial_effective_at" >= "activated_at" AND
    ("commercial_ends_at" IS NULL OR
      "commercial_ends_at" > "commercial_effective_at"));
