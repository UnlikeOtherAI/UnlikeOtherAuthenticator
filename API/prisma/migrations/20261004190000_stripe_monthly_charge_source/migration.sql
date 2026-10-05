BEGIN;

CREATE TABLE billing_stripe_monthly_charges (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES billing_stripe_subscriptions(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
  stripe_invoice_id varchar(255) NOT NULL UNIQUE,
  stripe_invoice_item_id varchar(255) UNIQUE,
  billing_month char(7) NOT NULL,
  period_starts_at timestamptz NOT NULL,
  period_ends_at timestamptz NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  authority_key char(64) NOT NULL UNIQUE,
  source_digest char(64) NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'PENDING',
  first_attempt_at timestamptz,
  last_error_code varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_stripe_monthly_charge_source_valid CHECK (
    billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND
    amount_minor >= 0 AND currency = 'USD' AND
    authority_key ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$' AND
    period_starts_at < period_ends_at AND
    state IN ('PENDING', 'ACCEPTED', 'HELD', 'NO_CHARGE') AND
    (state <> 'ACCEPTED' OR stripe_invoice_item_id IS NOT NULL) AND
    (state <> 'NO_CHARGE' OR (amount_minor = 0 AND stripe_invoice_item_id IS NULL)) AND
    (amount_minor <> 0 OR state = 'NO_CHARGE')
  ),
  CONSTRAINT billing_stripe_monthly_charge_attempt_valid CHECK (
    stripe_invoice_item_id IS NULL OR first_attempt_at IS NOT NULL
  )
);
CREATE UNIQUE INDEX billing_stripe_monthly_charge_subscription_month_key
  ON billing_stripe_monthly_charges(subscription_id, billing_month);
CREATE INDEX billing_stripe_monthly_charge_state_idx
  ON billing_stripe_monthly_charges(state, updated_at);

CREATE FUNCTION billing_stripe_monthly_charge_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.subscription_id, NEW.account_id, NEW.stripe_invoice_id,
      NEW.billing_month, NEW.period_starts_at, NEW.period_ends_at,
      NEW.amount_minor, NEW.currency, NEW.authority_key, NEW.source_digest,
      NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.subscription_id, OLD.account_id, OLD.stripe_invoice_id,
      OLD.billing_month, OLD.period_starts_at, OLD.period_ends_at,
      OLD.amount_minor, OLD.currency, OLD.authority_key, OLD.source_digest,
      OLD.idempotency_key, OLD.created_at) OR
     (OLD.first_attempt_at IS NOT NULL AND
       NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at) OR
     (OLD.stripe_invoice_item_id IS NOT NULL AND
       NEW.stripe_invoice_item_id IS DISTINCT FROM OLD.stripe_invoice_item_id) OR
     (OLD.state = 'ACCEPTED' AND NEW.state <> 'ACCEPTED') THEN
    RAISE EXCEPTION 'Stripe monthly charge source is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_stripe_monthly_charge_guard
BEFORE UPDATE ON billing_stripe_monthly_charges
FOR EACH ROW EXECUTE FUNCTION billing_stripe_monthly_charge_guard();

ALTER TABLE billing_stripe_monthly_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_stripe_monthly_charges FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_stripe_monthly_charges FROM uoa_app;
CREATE POLICY billing_stripe_monthly_charge_deny_app
  ON billing_stripe_monthly_charges FOR ALL TO uoa_app
  USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE ON billing_stripe_monthly_charges TO uoa_admin;

COMMIT;
