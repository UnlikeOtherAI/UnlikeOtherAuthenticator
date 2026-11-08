BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
-- Recovery progress is operational evidence, not a financial migration. Only
-- genuine provider invoices/cash can populate the existing invoice sources.
CREATE TABLE billing_addon_invoice_recoveries (
 subscription_id text PRIMARY KEY REFERENCES billing_recurring_addon_subscriptions(id) ON DELETE RESTRICT,
 account_id text NOT NULL REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
 org_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
 livemode boolean NOT NULL,
 scan_before timestamptz(3), cursor varchar(255), complete boolean NOT NULL DEFAULT false,
 completed_at timestamptz(3), lease_token uuid, lease_expires_at timestamptz(3),
 next_attempt_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0), hold_reason varchar(160),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK (complete=(completed_at IS NOT NULL)), CHECK (NOT complete OR scan_before IS NOT NULL)
);
CREATE INDEX billing_addon_invoice_recovery_due ON billing_addon_invoice_recoveries(complete,next_attempt_at);
ALTER TABLE billing_addon_invoice_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_addon_invoice_recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deny_all ON billing_addon_invoice_recoveries FOR ALL USING(false) WITH CHECK(false);
REVOKE ALL ON billing_addon_invoice_recoveries FROM PUBLIC,uoa_app;
GRANT SELECT,INSERT,UPDATE ON billing_addon_invoice_recoveries TO uoa_admin;
CREATE FUNCTION guard_addon_invoice_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ADDON_INVOICE_RECOVERY_RETAINED'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.subscription_id,NEW.account_id,NEW.org_id,NEW.livemode,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.subscription_id,OLD.account_id,OLD.org_id,OLD.livemode,OLD.created_at) OR
   OLD.scan_before IS NOT NULL AND NEW.scan_before IS DISTINCT FROM OLD.scan_before OR
   OLD.complete AND ROW(NEW.complete,NEW.completed_at,NEW.cursor) IS DISTINCT FROM ROW(OLD.complete,OLD.completed_at,OLD.cursor))
 THEN RAISE EXCEPTION 'ADDON_INVOICE_RECOVERY_BINDING_IMMUTABLE'; END IF;
 IF NOT EXISTS (SELECT 1 FROM billing_recurring_addon_subscriptions s WHERE s.id=NEW.subscription_id
   AND s.account_id=NEW.account_id AND s.org_id=NEW.org_id AND s.livemode=NEW.livemode)
 THEN RAISE EXCEPTION 'ADDON_INVOICE_RECOVERY_BINDING_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER addon_invoice_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_addon_invoice_recoveries
 FOR EACH ROW EXECUTE FUNCTION guard_addon_invoice_recovery();
CREATE FUNCTION enqueue_addon_invoice_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO billing_addon_invoice_recoveries(subscription_id,account_id,org_id,livemode)
 VALUES(NEW.id,NEW.account_id,NEW.org_id,NEW.livemode) ON CONFLICT(subscription_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER addon_invoice_recovery_enqueue AFTER INSERT ON billing_recurring_addon_subscriptions
 FOR EACH ROW EXECUTE FUNCTION enqueue_addon_invoice_recovery();
INSERT INTO billing_addon_invoice_recoveries(subscription_id,account_id,org_id,livemode)
 SELECT id,account_id,org_id,livemode FROM billing_recurring_addon_subscriptions;
COMMIT;
