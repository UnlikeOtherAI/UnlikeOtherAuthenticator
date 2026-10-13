SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE TABLE billing_failure_history_probes (
 account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id), invoice_id TEXT NOT NULL,
 cursor TEXT, earliest_failure_at TIMESTAMP(3) NOT NULL, complete BOOLEAN NOT NULL DEFAULT false,
 generation INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP(3) NOT NULL,
 PRIMARY KEY(account_id,invoice_id)
);
ALTER TABLE billing_failure_history_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_failure_history_probes FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_runtime_deny ON billing_failure_history_probes FOR ALL TO uoa_app USING(false) WITH CHECK(false);
