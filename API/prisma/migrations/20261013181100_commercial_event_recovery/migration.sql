SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE TABLE billing_commercial_event_scans (
 account_id TEXT PRIMARY KEY REFERENCES billing_stripe_accounts(id),
 from_second INTEGER NOT NULL, through_second INTEGER NOT NULL,
 cursor TEXT, generation INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(from_second<=through_second)
);
CREATE TABLE billing_commercial_event_recovery (
 account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id), event_id TEXT NOT NULL,
 event_type TEXT NOT NULL, object_id TEXT NOT NULL,
 completed_at TIMESTAMP(3), next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 attempt_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,event_id)
);
CREATE INDEX commercial_event_recovery_due_idx ON billing_commercial_event_recovery(next_attempt_at)
 WHERE completed_at IS NULL;
ALTER TABLE billing_storage_subscriptions ADD COLUMN paid_through TIMESTAMP(3);
-- No historical period is invented: only already verified immutable invoice
-- evidence plus a freshly validated period may populate this boundary.
ALTER TABLE billing_commercial_event_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_commercial_event_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_runtime_deny ON billing_commercial_event_scans FOR ALL TO uoa_app USING(false) WITH CHECK(false);
ALTER TABLE billing_commercial_event_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_commercial_event_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_runtime_deny ON billing_commercial_event_recovery FOR ALL TO uoa_app USING(false) WITH CHECK(false);
