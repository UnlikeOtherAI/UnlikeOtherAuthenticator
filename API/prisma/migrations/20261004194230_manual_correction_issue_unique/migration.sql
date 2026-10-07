BEGIN;

ALTER TABLE billing_invoices
  ADD COLUMN is_cycle_supplement boolean NOT NULL DEFAULT false;

-- Ordinary monthly invoices retain the historical one-active-issue rule.
-- Every supplement is separately bound to one original issued line and to
-- its immutable pending cycle before it can leave DRAFT.
DROP INDEX billing_invoices_one_active_issue;
CREATE UNIQUE INDEX billing_invoices_one_active_issue
  ON billing_invoices(org_id, billing_month, currency)
  WHERE status IN ('ISSUING', 'ISSUED') AND NOT is_cycle_supplement;

CREATE FUNCTION billing_invoice_supplement_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    NEW.is_cycle_supplement IS DISTINCT FROM OLD.is_cycle_supplement THEN
    RAISE EXCEPTION 'invoice supplement identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.is_cycle_supplement AND NEW.status IN ('ISSUING', 'ISSUED') AND
    (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') AND
    NOT public.uoa_billing_invoice_is_bound_supplement(NEW.id) THEN
    RAISE EXCEPTION 'unbound correction invoice cannot be issued' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_supplement_identity_guard
BEFORE INSERT OR UPDATE ON billing_invoices
FOR EACH ROW EXECUTE FUNCTION billing_invoice_supplement_identity_guard();

COMMIT;
