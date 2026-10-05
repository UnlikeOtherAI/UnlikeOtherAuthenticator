CREATE TABLE "billing_seat_subscriptions" (
  "id" TEXT PRIMARY KEY,
  "stripe_subscription_id" TEXT UNIQUE REFERENCES "billing_stripe_subscriptions"("id") ON DELETE RESTRICT,
  "contract_service_term_id" TEXT UNIQUE REFERENCES "billing_contract_service_terms"("id") ON DELETE RESTRICT,
  "service_id" TEXT NOT NULL REFERENCES "billing_services"("id") ON DELETE RESTRICT,
  "tariff_id" TEXT NOT NULL REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT,
  "org_id" TEXT NOT NULL REFERENCES "organisations"("id") ON DELETE RESTRICT,
  "team_id" TEXT REFERENCES "teams"("id") ON DELETE RESTRICT,
  "scope" "BillingAssignmentScope" NOT NULL,
  "seat_policy" "BillingSeatPolicy" NOT NULL,
  "seat_charge_timing" "BillingSeatChargeTiming" NOT NULL,
  "unit_amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "activated_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "baseline_captured_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_seat_subscription_source_check" CHECK (
    ("stripe_subscription_id" IS NOT NULL) <> ("contract_service_term_id" IS NOT NULL)),
  CONSTRAINT "billing_seat_subscription_scope_check" CHECK (
    ("scope" = 'TEAM' AND "team_id" IS NOT NULL) OR
    ("scope" = 'ORGANISATION' AND "team_id" IS NULL)),
  CONSTRAINT "billing_seat_subscription_time_check" CHECK (
    "baseline_captured_at" = "activated_at" AND
    ("ended_at" IS NULL OR "ended_at" > "activated_at")),
  CONSTRAINT "billing_seat_subscription_price_check" CHECK ("unit_amount_minor" >= 0)
);
CREATE INDEX "billing_seat_subscriptions_scope_activation_idx"
  ON "billing_seat_subscriptions"("service_id", "org_id", "team_id", "activated_at");

CREATE TABLE "billing_seat_membership_intervals" (
  "id" TEXT PRIMARY KEY,
  "seat_subscription_id" TEXT NOT NULL REFERENCES "billing_seat_subscriptions"("id") ON DELETE RESTRICT,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "baseline" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_seat_interval_time_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);
CREATE UNIQUE INDEX "billing_seat_intervals_subject_start_key"
  ON "billing_seat_membership_intervals"("seat_subscription_id", "user_id", "starts_at");
CREATE UNIQUE INDEX "billing_seat_intervals_one_open_key"
  ON "billing_seat_membership_intervals"("seat_subscription_id", "user_id")
  WHERE "ends_at" IS NULL;
CREATE INDEX "billing_seat_intervals_subscription_time_idx"
  ON "billing_seat_membership_intervals"("seat_subscription_id", "starts_at", "ends_at");

CREATE TABLE "billing_fixed_seat_capacity_revisions" (
  "id" TEXT PRIMARY KEY,
  "seat_subscription_id" TEXT NOT NULL REFERENCES "billing_seat_subscriptions"("id") ON DELETE RESTRICT,
  "quantity" INTEGER NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_fixed_seat_capacity_positive_check" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "billing_fixed_seat_capacity_effective_key"
  ON "billing_fixed_seat_capacity_revisions"("seat_subscription_id", "effective_at");
