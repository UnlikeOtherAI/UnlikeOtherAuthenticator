-- A fresh actor assertion plus the exact UOA offer/option is the customer
-- action idempotency identity. Replays recover the same local evidence row and
-- therefore the same Stripe idempotency key rather than creating another charge.
CREATE UNIQUE INDEX "billing_credit_top_up_checkouts_actor_offer_key"
  ON "billing_credit_top_up_checkouts"("app_key_id", "actor_jti", "offer_id");

CREATE UNIQUE INDEX "billing_credit_setup_checkouts_actor_option_key"
  ON "billing_credit_setup_checkouts"("app_key_id", "actor_jti", "option_id");
