BEGIN;

-- The test harness migrates each test into its own PostgreSQL schema. These
-- functions are SECURITY INVOKER and must resolve the caller's invoice schema;
-- no role gains privileges through the connection search path.
CREATE OR REPLACE FUNCTION billing_invoice_supplement_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    NEW.is_cycle_supplement IS DISTINCT FROM OLD.is_cycle_supplement THEN
    RAISE EXCEPTION 'invoice supplement identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.is_cycle_supplement AND NEW.status IN ('ISSUING', 'ISSUED') AND
    (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') AND
    NOT uoa_billing_invoice_is_bound_supplement(NEW.id) THEN
    RAISE EXCEPTION 'unbound correction invoice cannot be issued' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
