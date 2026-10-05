-- Historical immutable tariff versions retain their original flat monthly
-- charge and postpaid usage terms. New versions state both choices explicitly.
CREATE TYPE "BillingMonthlyChargeBasis" AS ENUM ('FLAT', 'PER_SEAT');
CREATE TYPE "BillingUsagePaymentMode" AS ENUM ('PAY_AS_YOU_GO', 'PREPAID');

ALTER TABLE "billing_tariffs"
  ADD COLUMN "monthly_charge_basis" "BillingMonthlyChargeBasis" NOT NULL DEFAULT 'FLAT',
  ADD COLUMN "usage_payment_mode" "BillingUsagePaymentMode" NOT NULL DEFAULT 'PAY_AS_YOU_GO';
