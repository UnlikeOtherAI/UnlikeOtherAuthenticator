ALTER TABLE billing_stripe_checkout_sessions
  ADD COLUMN usage_probe_month CHAR(7),
  ADD COLUMN usage_probe_evidence JSONB,
  ADD COLUMN usage_probe_next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE billing_stripe_checkout_sessions ADD CONSTRAINT billing_first_usage_probe_month_check CHECK
  (usage_probe_month IS NULL OR (seat_offer_id IS NOT NULL AND usage_probe_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'));
CREATE INDEX billing_first_usage_probe_work_idx ON billing_stripe_checkout_sessions(usage_probe_next_attempt_at)
  WHERE seat_offer_id IS NOT NULL AND usage_term_event_id IS NULL;
