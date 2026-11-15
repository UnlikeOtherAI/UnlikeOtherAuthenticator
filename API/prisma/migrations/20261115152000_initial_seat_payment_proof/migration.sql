BEGIN;
ALTER TABLE billing_stripe_subscriptions ADD COLUMN initial_seat_invoice_id text UNIQUE
  REFERENCES billing_stripe_payment_invoices(id) ON DELETE RESTRICT;

CREATE FUNCTION billing_initial_seat_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof billing_stripe_payment_invoices%ROWTYPE; cash_paid bigint;
BEGIN
  IF TG_OP='UPDATE' AND OLD.initial_seat_invoice_id IS NOT NULL AND NEW.initial_seat_invoice_id IS DISTINCT FROM OLD.initial_seat_invoice_id THEN
    RAISE EXCEPTION 'Initial seat payment evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.initial_seat_invoice_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.initial_seat_invoice_id IS NULL) THEN
    SELECT * INTO proof FROM billing_stripe_payment_invoices WHERE id=NEW.initial_seat_invoice_id;
    SELECT COALESCE(sum(amount_minor),0) INTO cash_paid FROM billing_stripe_payment_invoice_cash_payments
      WHERE invoice_id=proof.id;
    IF proof.subscription_id IS DISTINCT FROM NEW.id OR proof.account_id IS DISTINCT FROM NEW.account_id
      OR proof.livemode IS DISTINCT FROM NEW.livemode OR proof.org_id IS DISTINCT FROM NEW.org_id
      OR proof.team_id IS DISTINCT FROM NEW.team_id OR proof.due_amount_minor<=0 OR cash_paid<proof.due_amount_minor THEN
      RAISE EXCEPTION 'Initial seat payment is not collected and bound' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_initial_seat_payment_guard BEFORE INSERT OR UPDATE OF initial_seat_invoice_id ON billing_stripe_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_initial_seat_payment_guard();
COMMIT;
