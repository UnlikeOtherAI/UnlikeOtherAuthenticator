SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE billing_app_keys DROP CONSTRAINT billing_app_keys_purpose_origins_check;
ALTER TABLE billing_app_keys ADD CONSTRAINT billing_app_keys_purpose_origins_check CHECK (
  (purpose IN ('ENTITLEMENT','SMS_RUNTIME','COMMERCIAL_WORKER') AND cardinality(checkout_return_origins)=0)
  OR (purpose='CUSTOMER_LIFECYCLE' AND cardinality(checkout_return_origins)>0)
);

CREATE TABLE billing_product_enrollments (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
 org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
 source_domain TEXT NOT NULL REFERENCES client_domains(domain) ON DELETE RESTRICT,
 billing_timezone TEXT NOT NULL DEFAULT 'UTC', active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 UNIQUE(service_id,org_id)
);
-- Enroll only exact unambiguous direct-session evidence. No tariff, positive
-- price, manager statement or ambient origin creates a commercial enrollment.
WITH sources AS (
 SELECT DISTINCT access.service_id,access.org_id,domain.domain
 FROM billing_service_accesses access
 JOIN billing_app_keys key ON key.id=access.app_key_id AND key.service_id=access.service_id
 JOIN client_domains domain ON domain.domain=regexp_replace(regexp_replace(key.actor_issuer,'^https://',''),'/$','')
 JOIN billing_services service ON service.id=access.service_id AND service.active
 JOIN organisations org ON org.id=access.org_id AND org.lifecycle_status='ACTIVE'
 WHERE access.active AND access.revoked_at IS NULL AND domain.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM billing_app_keys current_key WHERE current_key.service_id=access.service_id
   AND current_key.actor_issuer=key.actor_issuer AND current_key.purpose='CUSTOMER_LIFECYCLE'
   AND current_key.revoked_at IS NULL AND (current_key.expires_at IS NULL OR current_key.expires_at>CURRENT_TIMESTAMP))
), exact_source AS (
 SELECT service_id,org_id,min(domain) source_domain FROM sources GROUP BY service_id,org_id HAVING count(*)=1
)
INSERT INTO billing_product_enrollments(id,service_id,org_id,source_domain,updated_at)
 SELECT gen_random_uuid()::text,service_id,org_id,source_domain,CURRENT_TIMESTAMP FROM exact_source;
CREATE TABLE billing_product_policy_revisions (
 id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES billing_product_enrollments(id) ON DELETE RESTRICT,
 private_at_cost BOOLEAN NOT NULL, trial_starts_at TIMESTAMP(3), trial_ends_at TIMESTAMP(3),
 effective_at TIMESTAMP(3) NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((trial_starts_at IS NULL AND trial_ends_at IS NULL) OR
   (trial_starts_at IS NOT NULL AND trial_ends_at > trial_starts_at)),
 CHECK (NOT private_at_cost OR trial_starts_at IS NULL)
);
CREATE INDEX billing_product_policy_effective_idx ON billing_product_policy_revisions(enrollment_id,effective_at);
CREATE TABLE billing_commercial_incidents (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
 org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
 category TEXT NOT NULL CHECK(category IN ('seat','storage','phone','addon')),
 base_subscription_id TEXT REFERENCES billing_stripe_subscriptions(id) ON DELETE RESTRICT,
 addon_subscription_id TEXT REFERENCES billing_recurring_addon_subscriptions(id) ON DELETE RESTRICT,
 storage_expansion_id TEXT, invoice_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES billing_stripe_accounts(id),
 resource_id TEXT REFERENCES billing_sms_number_resources(id) ON DELETE RESTRICT,
 failed_at TIMESTAMP(3) NOT NULL, grace_ends_at TIMESTAMP(3) NOT NULL,
 billing_timezone TEXT NOT NULL, failure_event_id TEXT NOT NULL REFERENCES billing_stripe_webhook_events(id),
 resolved_at TIMESTAMP(3), resolution_event_id TEXT REFERENCES billing_stripe_webhook_events(id),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(account_id,invoice_id), CHECK(grace_ends_at>failed_at),
 CHECK ((resolved_at IS NULL)=(resolution_event_id IS NULL)),
 CHECK ((category='seat' AND base_subscription_id IS NOT NULL AND addon_subscription_id IS NULL) OR
   (category='storage' AND storage_expansion_id IS NOT NULL AND base_subscription_id IS NULL AND addon_subscription_id IS NULL) OR
   (category IN ('phone','addon') AND addon_subscription_id IS NOT NULL AND base_subscription_id IS NULL))
);
CREATE INDEX billing_commercial_incident_company_idx ON billing_commercial_incidents(service_id,org_id,resolved_at,failed_at);
CREATE TABLE billing_commercial_notifications (
 id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES billing_commercial_incidents(id),
 stage TEXT NOT NULL CHECK(stage IN('initial','reminder','final_warning','restricted','resolved','release_due')),
 due_at TIMESTAMP(3) NOT NULL, email_sent_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(incident_id,stage)
);
CREATE TABLE billing_commercial_acknowledgements (
 service_id TEXT NOT NULL REFERENCES billing_services(id),
 notification_id TEXT NOT NULL REFERENCES billing_commercial_notifications(id),
 channel TEXT NOT NULL CHECK(channel IN('alert','personal_assistant','email')),
 recipient_user_id TEXT NOT NULL REFERENCES users(id),
 receipt_id TEXT NOT NULL CHECK(length(receipt_id)>0),
 acknowledged_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(service_id,notification_id,channel,recipient_user_id)
);
CREATE TABLE billing_storage_observations (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id),
 org_id TEXT NOT NULL REFERENCES organisations(id), observation_id TEXT NOT NULL,
 measurement_version TEXT NOT NULL,
 revision BIGINT NOT NULL CHECK(revision>=0), blob_bytes BIGINT NOT NULL CHECK(blob_bytes>=0),
 database_bytes BIGINT NOT NULL CHECK(database_bytes>=0), observed_at TIMESTAMP(3) NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(service_id,org_id,revision), UNIQUE(service_id,org_id,observation_id)
);

CREATE FUNCTION billing_commercial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Commercial evidence is append-only' USING ERRCODE='23514'; END $$;
CREATE FUNCTION billing_commercial_incident_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.resolved_at IS NOT NULL OR
   (to_jsonb(NEW)-'resolved_at'-'resolution_event_id') IS DISTINCT FROM
   (to_jsonb(OLD)-'resolved_at'-'resolution_event_id') OR NEW.resolved_at IS NULL THEN
   RAISE EXCEPTION 'Original commercial failure and deadline are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_commercial_incident_immutable BEFORE UPDATE OR DELETE ON billing_commercial_incidents
 FOR EACH ROW EXECUTE FUNCTION billing_commercial_incident_guard();
DO $$
DECLARE table_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['billing_product_enrollments','billing_product_policy_revisions',
   'billing_commercial_incidents','billing_commercial_notifications','billing_commercial_acknowledgements',
   'billing_storage_observations'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
   EXECUTE format('CREATE POLICY commercial_runtime_deny ON %I FOR ALL TO uoa_app USING(false) WITH CHECK(false)',table_name);
   IF table_name IN('billing_product_policy_revisions','billing_commercial_acknowledgements','billing_storage_observations') THEN
    EXECUTE format('CREATE TRIGGER commercial_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION billing_commercial_immutable()',table_name);
   END IF;
 END LOOP;
END $$;
