BEGIN;

CREATE FUNCTION billing_invoice_tax_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment OR
    NEW.tax_rate_bps IS DISTINCT FROM OLD.tax_rate_bps OR
    NEW.tax_legal_basis IS DISTINCT FROM OLD.tax_legal_basis
  ) THEN
    RAISE EXCEPTION 'invoice tax evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.tax_treatment IS NOT NULL AND NEW.tax_amount_minor::numeric <>
    floor((NEW.subtotal_minor::numeric * NEW.tax_rate_bps + 5000) / 10000) THEN
    RAISE EXCEPTION 'invoice tax differs from frozen policy' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_tax_evidence_guard
BEFORE INSERT OR UPDATE ON billing_invoices
FOR EACH ROW EXECUTE FUNCTION billing_invoice_tax_evidence_guard();

COMMIT;
