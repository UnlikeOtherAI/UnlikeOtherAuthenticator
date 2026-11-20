BEGIN;
ALTER TABLE verification_tokens ADD COLUMN product_preview_digest text, ADD COLUMN product_factor_digest text, ADD COLUMN product_receipt_id text, ADD COLUMN product_selection text;
CREATE TABLE product_erasure_policies (
 id text PRIMARY KEY, name text NOT NULL, mode text NOT NULL CHECK (mode IN ('PERSONAL','ORGANISATION')),
 enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 closed_bootstrap_domains text[] NOT NULL DEFAULT ARRAY[]::text[],
 disclosure text NOT NULL, domains text[] NOT NULL, native_apps text[] NOT NULL, settings text[] NOT NULL
);
CREATE TABLE product_erasure_jobs (
 id text PRIMARY KEY, policy_id text NOT NULL REFERENCES product_erasure_policies(id) ON DELETE RESTRICT,
 container_preserved boolean NOT NULL DEFAULT false, requested_container jsonb, container_job_id text REFERENCES entity_deletion_jobs(id) ON DELETE RESTRICT,
 rejoined_subject text, rejoined_at timestamp(3), notice_due_at timestamp(3) DEFAULT CURRENT_TIMESTAMP,
 subject text NOT NULL, revision integer NOT NULL, impact jsonb NOT NULL,
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at timestamp(3),
 UNIQUE(subject, policy_id)
);
CREATE INDEX product_erasure_generation_idx ON product_erasure_jobs(policy_id, rejoined_subject, rejoined_at);
CREATE INDEX product_erasure_notice_idx ON product_erasure_jobs(notice_due_at) WHERE completed_at IS NOT NULL;
CREATE TABLE product_erasure_receipts (
 job_id text NOT NULL REFERENCES product_erasure_jobs(id) ON DELETE CASCADE, domain_id text NOT NULL,
 acknowledged_at timestamp(3), outcome text CHECK (outcome IN ('PURGED','RETAINED_EVIDENCE')),
 PRIMARY KEY(job_id, domain_id)
);
CREATE INDEX product_erasure_receipts_domain_id_acknowledged_at_idx ON product_erasure_receipts(domain_id, acknowledged_at);
-- Once every participant has acknowledged, the receipt and admission fence only
-- need the product, subject, revision, outcome and dates.
CREATE FUNCTION scrub_completed_product_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.impact := '{}'::jsonb;
 NEW.requested_container := NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER scrub_completed_product_erasure BEFORE INSERT OR UPDATE ON product_erasure_jobs
FOR EACH ROW WHEN (NEW.completed_at IS NOT NULL) EXECUTE FUNCTION scrub_completed_product_erasure();

-- Requests, inventories and acknowledgements are visible only through the admin connection.
ALTER TABLE product_erasure_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_erasure_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_erasure_receipts ENABLE ROW LEVEL SECURITY;

-- Tenant transactions get a denial bit, never an enumerable request or writable authority row.
CREATE FUNCTION product_erasure_admission(person text, client_domain text, native_app text)
RETURNS TABLE(denied boolean, bootstrap_closed boolean) LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS (SELECT 1 FROM product_erasure_jobs j
 JOIN product_erasure_policies p ON p.id=j.policy_id
 WHERE j.subject=person AND (client_domain=ANY(p.domains) OR native_app=ANY(p.native_apps))),
 EXISTS (SELECT 1 FROM product_erasure_policies WHERE client_domain=ANY(closed_bootstrap_domains))
$$;

DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.product_erasure_admission(text,text,text) SET search_path = pg_catalog,%I,pg_temp', current_schema(), current_schema());
END $$;

REVOKE ALL ON product_erasure_jobs,product_erasure_receipts,product_erasure_policies FROM uoa_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON product_erasure_jobs,product_erasure_receipts,product_erasure_policies TO uoa_admin;
REVOKE ALL ON FUNCTION product_erasure_admission(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION product_erasure_admission(text,text,text) TO uoa_app,uoa_admin;

CREATE FUNCTION complete_product_container_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE product_erasure_jobs j SET completed_at=CURRENT_TIMESTAMP
 WHERE j.container_job_id=NEW.id AND j.completed_at IS NULL AND NOT EXISTS
   (SELECT 1 FROM product_erasure_receipts r WHERE r.job_id=j.id AND r.acknowledged_at IS NULL);
 RETURN NEW;
END $$;
CREATE TRIGGER complete_product_container_erasure AFTER UPDATE OF status ON entity_deletion_jobs
FOR EACH ROW WHEN (NEW.status='COMPLETE' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION complete_product_container_erasure();
-- All products may normally write shared settings. A stale sync from a different
-- client must also respect the erasure of an inventoried product key.
CREATE FUNCTION refuse_erased_product_setting() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM product_erasure_jobs j JOIN product_erasure_policies p ON p.id=j.policy_id
            WHERE j.subject=NEW.user_id AND (NEW.namespace || '/' || NEW.key)=ANY(p.settings)) THEN
   RAISE EXCEPTION 'PRODUCT_ACCOUNT_DELETED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.refuse_erased_product_setting() SET search_path = pg_catalog,%I,pg_temp', current_schema(), current_schema());
END $$;
CREATE TRIGGER refuse_erased_product_setting BEFORE INSERT OR UPDATE ON user_settings
FOR EACH ROW EXECUTE FUNCTION refuse_erased_product_setting();
REVOKE ALL ON FUNCTION refuse_erased_product_setting() FROM PUBLIC;
COMMIT;
