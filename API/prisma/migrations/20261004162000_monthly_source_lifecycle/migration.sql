ALTER TABLE "billing_stripe_subscriptions"
  ADD COLUMN "billable_from" TIMESTAMP(3),
  ADD COLUMN "billable_until" TIMESTAMP(3),
  ADD CONSTRAINT "billing_stripe_billable_interval_check" CHECK (
    "billable_until" IS NULL OR
    ("billable_from" IS NOT NULL AND "billable_until" > "billable_from")
  );

CREATE FUNCTION billing_monthly_source_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'billing_seat_subscriptions' THEN
    IF NEW.commercial_effective_at IS DISTINCT FROM OLD.commercial_effective_at OR
       (OLD.commercial_ends_at IS NOT NULL AND
        NEW.commercial_ends_at IS DISTINCT FROM OLD.commercial_ends_at) THEN
      RAISE EXCEPTION 'Seat commercial boundaries are immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'billing_stripe_subscriptions' THEN
    IF (OLD.billable_from IS NOT NULL AND
        NEW.billable_from IS DISTINCT FROM OLD.billable_from) OR
       (OLD.billable_until IS NOT NULL AND
        NEW.billable_until IS DISTINCT FROM OLD.billable_until) THEN
      RAISE EXCEPTION 'Stripe monthly billable boundaries are immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.fixed_seat_quantity IS DISTINCT FROM OLD.fixed_seat_quantity THEN
    RAISE EXCEPTION 'Purchased seat quantity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER billing_seat_commercial_immutable
  BEFORE UPDATE ON billing_seat_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_monthly_source_immutability();
CREATE TRIGGER billing_stripe_billable_immutable
  BEFORE UPDATE ON billing_stripe_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_monthly_source_immutability();
CREATE TRIGGER billing_checkout_seat_quantity_immutable
  BEFORE UPDATE ON billing_stripe_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION billing_monthly_source_immutability();
CREATE TRIGGER billing_contract_seat_quantity_immutable
  BEFORE UPDATE ON billing_contract_service_terms
  FOR EACH ROW EXECUTE FUNCTION billing_monthly_source_immutability();
