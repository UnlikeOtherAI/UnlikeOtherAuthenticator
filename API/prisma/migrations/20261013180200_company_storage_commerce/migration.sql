SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE TABLE billing_storage_catalogs (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id),
 account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id), currency TEXT NOT NULL CHECK(currency IN('EUR','GBP','USD')),
 unit_amount_minor BIGINT NOT NULL CHECK(unit_amount_minor>0), stripe_product_id TEXT NOT NULL,
 stripe_price_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(service_id,account_id,currency,version), UNIQUE(account_id,stripe_price_id)
);
CREATE TABLE billing_storage_mandates (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id), org_id TEXT NOT NULL REFERENCES organisations(id),
 account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id), catalog_id TEXT NOT NULL REFERENCES billing_storage_catalogs(id),
 app_key_id TEXT NOT NULL REFERENCES billing_app_keys(id), action_intent_id TEXT NOT NULL UNIQUE REFERENCES billing_customer_action_intents(id),
 requested_by_user_id TEXT NOT NULL REFERENCES users(id), requested_team_id TEXT NOT NULL REFERENCES teams(id),
 consent_version TEXT NOT NULL, consent_terms JSONB NOT NULL, stripe_customer_id TEXT NOT NULL,
 stripe_checkout_id TEXT UNIQUE, stripe_setup_intent_id TEXT UNIQUE, stripe_payment_method_id TEXT,
 state TEXT NOT NULL DEFAULT 'creating' CHECK(state IN('creating','open','accepted','expired','revoked')),
 accepted_at TIMESTAMP(3), revoked_at TIMESTAMP(3), success_url TEXT NOT NULL, cancel_url TEXT NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 CHECK(state<>'accepted' OR (accepted_at IS NOT NULL AND stripe_payment_method_id IS NOT NULL AND stripe_setup_intent_id IS NOT NULL))
);
CREATE INDEX billing_storage_mandate_company_idx ON billing_storage_mandates(service_id,org_id,account_id,state);
CREATE TABLE billing_storage_subscriptions (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id), org_id TEXT NOT NULL REFERENCES organisations(id),
 account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id), mandate_id TEXT NOT NULL REFERENCES billing_storage_mandates(id),
 catalog_id TEXT NOT NULL REFERENCES billing_storage_catalogs(id), stripe_subscription_id TEXT NOT NULL UNIQUE,
 stripe_item_id TEXT NOT NULL, purchased_blocks INTEGER NOT NULL DEFAULT 0 CHECK(purchased_blocks>=0),
 pending_blocks INTEGER NOT NULL DEFAULT 0 CHECK(pending_blocks>=0), state TEXT NOT NULL,
 current_period_end TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 UNIQUE(service_id,org_id,account_id)
);
CREATE TABLE billing_storage_expansions (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id), org_id TEXT NOT NULL REFERENCES organisations(id),
 mandate_id TEXT NOT NULL REFERENCES billing_storage_mandates(id), subscription_id TEXT REFERENCES billing_storage_subscriptions(id),
 operation_id TEXT NOT NULL, minimum_bytes BIGINT NOT NULL CHECK(minimum_bytes>=0),
 from_blocks INTEGER NOT NULL CHECK(from_blocks>=0), to_blocks INTEGER NOT NULL CHECK(to_blocks>from_blocks),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','paid','failed','reconciliation_required')),
 stripe_invoice_id TEXT UNIQUE, first_attempted_at TIMESTAMP(3), payment_proven_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 UNIQUE(service_id,org_id,operation_id), CHECK((state='paid')=(payment_proven_at IS NOT NULL))
);
CREATE UNIQUE INDEX billing_storage_one_unresolved_expansion ON billing_storage_expansions(service_id,org_id)
 WHERE state IN('pending','processing','failed','reconciliation_required');
ALTER TABLE billing_commercial_incidents ADD CONSTRAINT billing_commercial_storage_source_fk
 FOREIGN KEY(storage_expansion_id) REFERENCES billing_storage_expansions(id);
DO $$
DECLARE table_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['billing_storage_catalogs','billing_storage_mandates','billing_storage_subscriptions','billing_storage_expansions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY commercial_runtime_deny ON %I FOR ALL TO uoa_app USING(false) WITH CHECK(false)',table_name);
 END LOOP;
END $$;
CREATE TRIGGER storage_catalog_immutable BEFORE UPDATE OR DELETE ON billing_storage_catalogs
 FOR EACH ROW EXECUTE FUNCTION billing_commercial_immutable();
