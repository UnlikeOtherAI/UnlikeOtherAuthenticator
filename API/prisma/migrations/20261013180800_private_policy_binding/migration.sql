SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_product_policy_revisions ADD COLUMN private_term_event_id TEXT
 REFERENCES billing_tariff_term_events(id);
ALTER TABLE billing_product_policy_revisions ADD CONSTRAINT commercial_private_term_binding
 CHECK(private_at_cost=(private_term_event_id IS NOT NULL));
