SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_commercial_notifications ADD COLUMN last_polled_at TIMESTAMP(3);
ALTER TABLE billing_storage_payment_attempts ADD COLUMN recovery_action_intent_id TEXT UNIQUE
 REFERENCES billing_customer_action_intents(id);
