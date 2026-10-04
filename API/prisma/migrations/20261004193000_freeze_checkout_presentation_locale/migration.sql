-- Keep retries on the original language so Stripe idempotency parameters stay identical.
-- Existing attempts keep NULL and omit Stripe locale, exactly as at creation.
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD COLUMN "checkout_locale" VARCHAR(5),
  ADD CONSTRAINT "billing_stripe_checkout_locale_supported"
  CHECK ("checkout_locale" IS NULL OR "checkout_locale" IN ('cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'));

ALTER TABLE "billing_recurring_addon_checkouts"
  ADD COLUMN "checkout_locale" VARCHAR(5),
  ADD CONSTRAINT "billing_recurring_checkout_locale_supported"
  CHECK ("checkout_locale" IS NULL OR "checkout_locale" IN ('cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'));
