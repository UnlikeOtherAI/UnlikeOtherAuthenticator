BEGIN;
ALTER TABLE billing_credit_budget_dispatches
  ADD COLUMN service_id text NOT NULL,
  ADD COLUMN provider_service_id varchar(160) NOT NULL,
  ADD COLUMN org_id text NOT NULL,
  ADD COLUMN team_id text NOT NULL,
  ADD COLUMN user_id text NOT NULL,
  ADD COLUMN billing_month char(7) NOT NULL,
  ADD COLUMN currency char(3) NOT NULL,
  ADD COLUMN tariff_id text NOT NULL,
  ADD COLUMN frozen_markup_bps integer NOT NULL,
  ADD COLUMN tariff_mode varchar(24) NOT NULL,
  ADD COLUMN payment_mode varchar(24) NOT NULL,
  ADD CONSTRAINT billing_credit_budget_dispatch_mode CHECK
    (payment_mode IN ('PREPAID','PAY_AS_YOU_GO')),
  ADD CONSTRAINT billing_credit_budget_dispatch_tariff_mode CHECK
    (tariff_mode IN ('FREE','STANDARD','AT_COST','CUSTOM'));
COMMIT;
