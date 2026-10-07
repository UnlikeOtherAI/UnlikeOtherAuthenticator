SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- A retry of an open base subscription Checkout must keep the locale Stripe
-- received with the original idempotency key.
CREATE FUNCTION "billing_stripe_checkout_locale_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."checkout_locale" IS DISTINCT FROM OLD."checkout_locale" THEN
    RAISE EXCEPTION 'base Stripe Checkout locale is immutable after creation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_stripe_checkout_locale_immutable"
  BEFORE UPDATE OF "checkout_locale" ON "billing_stripe_checkout_sessions"
  FOR EACH ROW EXECUTE FUNCTION "billing_stripe_checkout_locale_immutable_guard"();
