BEGIN;
ALTER TABLE billing_stripe_monthly_charges
  ALTER COLUMN stripe_invoice_id DROP NOT NULL,
  ADD COLUMN allocation_kind varchar(16) NOT NULL DEFAULT 'RENEWAL',
  ADD COLUMN first_invoice_attempt_at timestamptz,
  ADD COLUMN invoice_lease_token uuid,
  ADD COLUMN invoice_lease_expires_at timestamptz,
  ADD CONSTRAINT billing_monthly_invoice_allocation_valid CHECK (
    allocation_kind IN ('RENEWAL', 'CLOSING') AND
    (allocation_kind = 'CLOSING' OR stripe_invoice_id IS NOT NULL) AND
    (state <> 'ACCEPTED' OR stripe_invoice_id IS NOT NULL) AND
    (invoice_lease_token IS NULL) = (invoice_lease_expires_at IS NULL) AND
    (allocation_kind <> 'CLOSING' OR stripe_invoice_id IS NULL OR first_invoice_attempt_at IS NOT NULL)
  );
CREATE OR REPLACE FUNCTION billing_stripe_monthly_charge_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.subscription_id, NEW.account_id, NEW.allocation_kind,
      NEW.billing_month, NEW.period_starts_at, NEW.period_ends_at,
      NEW.amount_minor, NEW.currency, NEW.authority_key, NEW.source_digest,
      NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.subscription_id, OLD.account_id, OLD.allocation_kind,
      OLD.billing_month, OLD.period_starts_at, OLD.period_ends_at,
      OLD.amount_minor, OLD.currency, OLD.authority_key, OLD.source_digest,
      OLD.idempotency_key, OLD.created_at) OR
     (OLD.stripe_invoice_id IS NOT NULL AND NEW.stripe_invoice_id IS DISTINCT FROM OLD.stripe_invoice_id) OR
     (OLD.stripe_invoice_id IS NULL AND NEW.stripe_invoice_id IS NOT NULL AND OLD.allocation_kind <> 'CLOSING') OR
     (OLD.first_invoice_attempt_at IS NOT NULL AND NEW.first_invoice_attempt_at IS DISTINCT FROM OLD.first_invoice_attempt_at) OR
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

COMMIT;
