BEGIN;
CREATE FUNCTION billing_stripe_cash_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE intent text; intent_ids text[]; duplicate boolean;
BEGIN
  IF TG_TABLE_NAME = 'billing_stripe_payment_invoices' THEN
    intent_ids := NEW.stripe_payment_intent_ids;
  ELSE
    intent_ids := ARRAY[NEW.stripe_payment_intent_id];
  END IF;
  IF cardinality(intent_ids) = 0 OR array_position(intent_ids, NULL) IS NOT NULL OR
    cardinality(intent_ids) <> (SELECT count(DISTINCT value) FROM unnest(intent_ids) value) THEN
    RAISE EXCEPTION 'Stripe cash payment set is invalid' USING ERRCODE = '23514';
  END IF;
  FOR intent IN SELECT value FROM unnest(intent_ids) value ORDER BY value COLLATE "C" LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW.account_id)::text || ':' ||
      NEW.account_id || ':' || intent, 0));
    IF TG_TABLE_NAME = 'billing_stripe_payment_invoices' THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.billing_stripe_payment_invoices
        WHERE account_id = $1 AND livemode = $2 AND stripe_invoice_id <> $3
          AND $4 = ANY(stripe_payment_intent_ids))
        OR EXISTS(SELECT 1 FROM %I.billing_credit_payment_invoices
        WHERE account_id = $1 AND livemode = $2 AND stripe_payment_intent_id = $4)',
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
        INTO duplicate USING NEW.account_id, NEW.livemode, NEW.stripe_invoice_id, intent;
    ELSE
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.billing_stripe_payment_invoices
        WHERE account_id = $1 AND livemode = $2 AND $3 = ANY(stripe_payment_intent_ids))', TG_TABLE_SCHEMA)
        INTO duplicate USING NEW.account_id, NEW.livemode, intent;
    END IF;
    IF duplicate THEN
      RAISE EXCEPTION 'Stripe cash payment already has an invoice source' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_regular_cash_unique BEFORE INSERT ON billing_stripe_payment_invoices
  FOR EACH ROW EXECUTE FUNCTION billing_stripe_cash_source_guard();
CREATE TRIGGER stripe_prepaid_cash_unique BEFORE INSERT ON billing_credit_payment_invoices
  FOR EACH ROW EXECUTE FUNCTION billing_stripe_cash_source_guard();
COMMIT;
