SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE TABLE billing_storage_payment_attempts (
 id TEXT PRIMARY KEY, expansion_id TEXT NOT NULL REFERENCES billing_storage_expansions(id),
 mandate_id TEXT NOT NULL REFERENCES billing_storage_mandates(id), generation INTEGER NOT NULL CHECK(generation>0),
 stripe_subscription_id TEXT, stripe_invoice_id TEXT, terminal_unpaid_proven_at TIMESTAMP(3), first_attempted_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(expansion_id,generation)
);
ALTER TABLE billing_storage_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_storage_payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_runtime_deny ON billing_storage_payment_attempts FOR ALL TO uoa_app USING(false) WITH CHECK(false);
