BEGIN;
CREATE FUNCTION billing_stripe_cash_adjustment_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE payment record; prior_refunds bigint; withdrawn bigint;
BEGIN
  EXECUTE format('SELECT id FROM %I.billing_stripe_payment_invoices WHERE id = $1 FOR UPDATE',
    TG_TABLE_SCHEMA) USING NEW.invoice_id;
  EXECUTE format('SELECT amount_minor, currency FROM %I.billing_stripe_payment_invoice_cash_payments
    WHERE invoice_id = $1 AND stripe_payment_intent_id = $2 AND stripe_charge_id = $3', TG_TABLE_SCHEMA)
    INTO payment USING NEW.invoice_id, NEW.stripe_payment_intent_id, NEW.stripe_charge_id;
  IF payment IS NULL OR NEW.currency IS DISTINCT FROM payment.currency OR NEW.amount_minor > payment.amount_minor THEN
    RAISE EXCEPTION 'Stripe invoice cash adjustment has no exact original payment' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'REFUND' THEN
    EXECUTE format('SELECT coalesce(sum(amount_minor), 0) FROM %I.billing_stripe_payment_invoice_adjustments
      WHERE invoice_id = $1 AND stripe_payment_intent_id = $2 AND kind = ''REFUND''', TG_TABLE_SCHEMA)
      INTO prior_refunds USING NEW.invoice_id, NEW.stripe_payment_intent_id;
    IF prior_refunds + NEW.amount_minor > payment.amount_minor THEN
      RAISE EXCEPTION 'Stripe invoice refunds exceed original payment' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.kind = 'DISPUTE_REVERSAL' THEN
    EXECUTE format('SELECT amount_minor FROM %I.billing_stripe_payment_invoice_adjustments
      WHERE invoice_id = $1 AND stripe_payment_intent_id = $2 AND stripe_object_id = $3 AND kind = ''DISPUTE''',
      TG_TABLE_SCHEMA) INTO withdrawn USING NEW.invoice_id, NEW.stripe_payment_intent_id, NEW.stripe_object_id;
    IF withdrawn IS NULL OR NEW.amount_minor > withdrawn THEN
      RAISE EXCEPTION 'Stripe invoice dispute reinstatement has no exact withdrawal' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_cash_adjustment_insert_guard BEFORE INSERT
  ON billing_stripe_payment_invoice_adjustments FOR EACH ROW EXECUTE FUNCTION billing_stripe_cash_adjustment_insert_guard();
COMMIT;
