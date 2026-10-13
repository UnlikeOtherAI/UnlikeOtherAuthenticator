SET lock_timeout = '5s';
SET statement_timeout = '120s';
-- Registered domains use lowercase status; entity lifecycle is a separate enum.
WITH sources AS (
 SELECT DISTINCT access.service_id,access.org_id,domain.domain
 FROM billing_service_accesses access
 JOIN billing_app_keys key ON key.id=access.app_key_id AND key.service_id=access.service_id
 JOIN client_domains domain ON domain.domain=regexp_replace(regexp_replace(key.actor_issuer,'^https://',''),'/$','')
 JOIN billing_services service ON service.id=access.service_id AND service.active
 JOIN organisations org ON org.id=access.org_id AND org.lifecycle_status='ACTIVE'
 WHERE access.active AND access.revoked_at IS NULL AND domain.status='active'
 AND EXISTS(SELECT 1 FROM billing_app_keys current_key WHERE current_key.service_id=access.service_id
   AND current_key.actor_issuer=key.actor_issuer AND current_key.purpose='CUSTOMER_LIFECYCLE'
   AND current_key.revoked_at IS NULL AND (current_key.expires_at IS NULL OR current_key.expires_at>CURRENT_TIMESTAMP))
), exact_source AS (
 SELECT service_id,org_id,min(domain) source_domain FROM sources GROUP BY service_id,org_id HAVING count(*)=1
)
INSERT INTO billing_product_enrollments(id,service_id,org_id,source_domain,updated_at)
 SELECT gen_random_uuid()::text,service_id,org_id,source_domain,CURRENT_TIMESTAMP FROM exact_source
 ON CONFLICT(service_id,org_id) DO NOTHING;
