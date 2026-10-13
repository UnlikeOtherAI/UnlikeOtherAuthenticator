SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_storage_subscriptions ADD COLUMN current_period_start TIMESTAMP(3);
CREATE TABLE billing_storage_payment_evidence (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id),
 invoice_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES billing_storage_payment_attempts(id),
 webhook_event_id TEXT NOT NULL REFERENCES billing_stripe_webhook_events(id),
 currency TEXT NOT NULL, amount_minor BIGINT NOT NULL CHECK(amount_minor>0), cash_evidence JSONB NOT NULL,
 paid_at TIMESTAMP(3) NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(account_id,invoice_id)
);
CREATE TRIGGER commercial_immutable BEFORE UPDATE OR DELETE ON billing_storage_payment_evidence
 FOR EACH ROW EXECUTE FUNCTION billing_commercial_immutable();
ALTER TABLE billing_storage_payment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_storage_payment_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_runtime_deny ON billing_storage_payment_evidence FOR ALL TO uoa_app USING(false) WITH CHECK(false);
