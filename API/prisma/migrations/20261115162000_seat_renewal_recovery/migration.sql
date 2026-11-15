BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE TABLE billing_seat_payment_periods (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES billing_stripe_subscriptions(id) ON DELETE RESTRICT,
  invoice_id text NOT NULL REFERENCES billing_stripe_payment_invoices(id) ON DELETE RESTRICT,
  stripe_line_id text NOT NULL,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL CHECK(ends_at>starts_at),
  quantity integer NOT NULL CHECK(quantity>0),
  UNIQUE(invoice_id,stripe_line_id)
);
CREATE INDEX billing_seat_payment_periods_scope_idx ON billing_seat_payment_periods(subscription_id,starts_at,ends_at);
CREATE TABLE billing_seat_renewal_recovery (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
  subscription_id text NOT NULL REFERENCES billing_stripe_subscriptions(id) ON DELETE RESTRICT,
  stripe_invoice_id text NOT NULL,
  failed_at timestamptz(3) NOT NULL,
  grace_ends_at timestamptz(3) NOT NULL CHECK(grace_ends_at>failed_at),
  reason text NOT NULL CHECK(reason IN ('payment_required','payment_action_required','card_expired')),
  payment_invoice_id text REFERENCES billing_stripe_payment_invoices(id) ON DELETE RESTRICT,
  recovered_at timestamptz(3),
  CHECK((payment_invoice_id IS NULL)=(recovered_at IS NULL)),
  UNIQUE(account_id,stripe_invoice_id)
);
CREATE INDEX billing_seat_renewal_recovery_scope_idx ON billing_seat_renewal_recovery(subscription_id,recovered_at,grace_ends_at);
CREATE TABLE billing_seat_failure_history (
  account_id text NOT NULL REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
  stripe_invoice_id text NOT NULL,
  earliest_failure_at timestamptz(3) NOT NULL,
  cursor text,
  complete boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,stripe_invoice_id)
);
CREATE FUNCTION billing_seat_payment_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_stripe_payment_invoices; sub billing_stripe_subscriptions; collected bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Collected seat coverage is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT receipt FROM billing_stripe_payment_invoices WHERE id=NEW.invoice_id;
  SELECT * INTO STRICT sub FROM billing_stripe_subscriptions WHERE id=NEW.subscription_id;
  SELECT COALESCE(sum(amount_minor),0) INTO collected FROM billing_stripe_payment_invoice_cash_payments WHERE invoice_id=receipt.id;
  IF receipt.subscription_id IS DISTINCT FROM sub.id OR receipt.account_id<>sub.account_id OR receipt.livemode<>sub.livemode
    OR collected<receipt.due_amount_minor OR receipt.due_amount_minor<=0
    OR NOT EXISTS(SELECT 1 FROM billing_stripe_payment_invoice_lines l WHERE l.invoice_id=receipt.id
      AND l.stripe_line_id=NEW.stripe_line_id AND l.service_id=sub.service_id AND l.subscription_minor>0) THEN
    RAISE EXCEPTION 'Seat coverage requires a bound collected invoice line' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_seat_payment_period_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_seat_payment_periods
  FOR EACH ROW EXECUTE FUNCTION billing_seat_payment_period_guard();
CREATE FUNCTION billing_seat_renewal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_stripe_payment_invoices; collected bigint;
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (
    (NEW.id,NEW.account_id,NEW.subscription_id,NEW.stripe_invoice_id,NEW.failed_at,NEW.grace_ends_at,NEW.reason)
      IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.subscription_id,OLD.stripe_invoice_id,OLD.failed_at,OLD.grace_ends_at,OLD.reason)
    OR (OLD.recovered_at IS NOT NULL AND NEW IS DISTINCT FROM OLD))) THEN
    RAISE EXCEPTION 'Seat renewal recovery evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM billing_stripe_subscriptions b WHERE b.id=NEW.subscription_id AND b.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Seat renewal account binding is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.payment_invoice_id IS NOT NULL THEN
    SELECT * INTO STRICT receipt FROM billing_stripe_payment_invoices WHERE id=NEW.payment_invoice_id;
    SELECT COALESCE(sum(amount_minor),0) INTO collected FROM billing_stripe_payment_invoice_cash_payments WHERE invoice_id=receipt.id;
    IF receipt.subscription_id IS DISTINCT FROM NEW.subscription_id OR receipt.account_id<>NEW.account_id
      OR receipt.stripe_invoice_id<>NEW.stripe_invoice_id OR receipt.due_amount_minor<=0 OR collected<receipt.due_amount_minor
      OR NOT EXISTS(SELECT 1 FROM billing_seat_payment_periods p WHERE p.invoice_id=receipt.id
        AND p.subscription_id=NEW.subscription_id) THEN
      RAISE EXCEPTION 'Seat renewal recovery requires its collected invoice' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_seat_renewal_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_seat_renewal_recovery
  FOR EACH ROW EXECUTE FUNCTION billing_seat_renewal_guard();
ALTER TABLE billing_seat_payment_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_seat_payment_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_seat_renewal_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_seat_renewal_recovery FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_seat_failure_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_seat_failure_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_seat_payment_periods,billing_seat_renewal_recovery,billing_seat_failure_history FROM PUBLIC,uoa_app;
GRANT SELECT,INSERT ON billing_seat_payment_periods TO uoa_admin;
GRANT SELECT,INSERT,UPDATE ON billing_seat_renewal_recovery,billing_seat_failure_history TO uoa_admin;
-- One current-payment predicate for invitation issuance and product access.
CREATE FUNCTION billing_nessie_subscription_paid_now(p_subscription text,p_now timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM billing_stripe_subscriptions b
    WHERE b.id=p_subscription AND b.status='active' AND b.initial_seat_invoice_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM billing_seat_renewal_recovery r WHERE r.subscription_id=b.id AND r.recovered_at IS NULL)
      AND EXISTS(SELECT 1 FROM billing_seat_payment_periods p JOIN billing_stripe_payment_invoices i ON i.id=p.invoice_id
        WHERE p.subscription_id=b.id AND p.starts_at<=p_now AND p.ends_at>p_now
          AND i.subscription_id=b.id AND i.account_id=b.account_id AND i.livemode=b.livemode AND i.due_amount_minor>0
          AND (SELECT COALESCE(sum(c.amount_minor),0) FROM billing_stripe_payment_invoice_cash_payments c WHERE c.invoice_id=i.id)
            -(SELECT COALESCE(sum(CASE WHEN a.kind='DISPUTE_REVERSAL' THEN -a.amount_minor ELSE a.amount_minor END),0)
              FROM billing_stripe_payment_invoice_adjustments a WHERE a.invoice_id=i.id)>=i.due_amount_minor)
      AND NOT EXISTS(SELECT 1 FROM billing_seat_payment_periods p JOIN billing_stripe_payment_invoices i ON i.id=p.invoice_id
        WHERE p.subscription_id=b.id AND p.starts_at<=p_now AND p.ends_at>p_now
          AND (SELECT COALESCE(sum(c.amount_minor),0) FROM billing_stripe_payment_invoice_cash_payments c WHERE c.invoice_id=i.id)
            -(SELECT COALESCE(sum(CASE WHEN a.kind='DISPUTE_REVERSAL' THEN -a.amount_minor ELSE a.amount_minor END),0)
              FROM billing_stripe_payment_invoice_adjustments a WHERE a.invoice_id=i.id)<i.due_amount_minor));
$$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION billing_nessie_subscription_paid_now(text,timestamptz) SET search_path=pg_catalog,%I,pg_temp',current_schema());
END; $$;
REVOKE ALL ON FUNCTION billing_nessie_subscription_paid_now(text,timestamptz) FROM PUBLIC,uoa_app;
GRANT EXECUTE ON FUNCTION billing_nessie_subscription_paid_now(text,timestamptz) TO uoa_admin;
COMMIT;
