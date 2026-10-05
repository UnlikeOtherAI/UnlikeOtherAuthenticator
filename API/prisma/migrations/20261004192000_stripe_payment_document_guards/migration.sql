BEGIN;
CREATE FUNCTION billing_stripe_payment_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE totals record;
BEGIN
  IF NEW.state = 'ISSUED' THEN
    SELECT count(*) AS count, sum(gross_minor) AS gross, sum(tax_minor) AS tax,
      sum(credit_minor) AS credit, sum(due_minor) AS due INTO totals
      FROM billing_stripe_payment_invoice_lines WHERE invoice_id = NEW.id;
    IF totals.count = 0 OR ROW(totals.gross, totals.tax, totals.credit, totals.due)
      IS DISTINCT FROM ROW(NEW.gross_amount_minor, NEW.tax_amount_minor,
        NEW.credit_amount_minor, NEW.due_amount_minor) THEN
      RAISE EXCEPTION 'Stripe payment document line allocation is unproven' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW.invoice_number IS NOT NULL OR NEW.issued_at IS NOT NULL OR
      NEW.issuer_snapshot IS NOT NULL OR NEW.buyer_snapshot IS NOT NULL OR
      NEW.pdf_object_key IS NOT NULL OR NEW.pdf_sha256 IS NOT NULL) AND
      (NEW.state <> 'ISSUED' OR NEW.invoice_number IS NULL OR NEW.issued_at IS NULL OR
       NEW.issuer_snapshot IS NULL OR NEW.buyer_snapshot IS NULL OR
       NEW.pdf_object_key IS NULL OR NEW.pdf_sha256 IS NULL) THEN
    RAISE EXCEPTION 'Stripe payment document facts must freeze atomically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_payment_document_guard BEFORE INSERT OR UPDATE
  ON billing_stripe_payment_invoices FOR EACH ROW EXECUTE FUNCTION billing_stripe_payment_document_guard();

CREATE FUNCTION billing_stripe_payment_line_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE source_state text;
BEGIN
  SELECT state INTO source_state FROM billing_stripe_payment_invoices
    WHERE id = NEW.invoice_id FOR UPDATE;
  IF source_state IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'Stripe payment invoice lines must precede document issue' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_payment_line_insert_guard BEFORE INSERT ON billing_stripe_payment_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION billing_stripe_payment_line_insert_guard();
COMMIT;
