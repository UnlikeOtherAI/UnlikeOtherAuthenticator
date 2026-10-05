CREATE TYPE "BillingSeatPolicy" AS ENUM ('AUTOMATIC', 'FIXED');
CREATE TYPE "BillingSeatChargeTiming" AS ENUM ('FULL_MONTH', 'PRORATED');
ALTER TABLE "billing_tariffs"
  ADD COLUMN "seat_policy" "BillingSeatPolicy",
  ADD COLUMN "seat_charge_timing" "BillingSeatChargeTiming";
ALTER TABLE "billing_tariffs" ADD CONSTRAINT "billing_tariffs_seat_terms_check"
  CHECK (("monthly_charge_basis" = 'FLAT' AND "seat_policy" IS NULL AND "seat_charge_timing" IS NULL)
    OR ("monthly_charge_basis" = 'PER_SEAT' AND "seat_policy" IS NOT NULL AND "seat_charge_timing" IS NOT NULL));
