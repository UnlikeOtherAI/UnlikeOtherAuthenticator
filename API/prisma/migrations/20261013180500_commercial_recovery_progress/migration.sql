SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_storage_payment_attempts ADD COLUMN scan_cursor TEXT,
 ADD COLUMN scan_complete BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN last_attempt_at TIMESTAMP(3);
CREATE TABLE billing_commercial_email_deliveries (
 id TEXT PRIMARY KEY,
 notification_id TEXT NOT NULL REFERENCES billing_commercial_notifications(id),
 recipient_user_id TEXT NOT NULL REFERENCES users(id),
 next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 accepted_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(notification_id, recipient_user_id)
);
CREATE INDEX billing_commercial_email_pending ON billing_commercial_email_deliveries(accepted_at,next_attempt_at);
ALTER TABLE billing_commercial_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_commercial_email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_runtime_deny ON billing_commercial_email_deliveries FOR ALL TO uoa_app USING(false) WITH CHECK(false);
