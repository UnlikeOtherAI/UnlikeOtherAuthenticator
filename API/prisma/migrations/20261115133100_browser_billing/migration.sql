SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE billing_app_keys DROP CONSTRAINT billing_app_keys_purpose_origins_check;
ALTER TABLE billing_app_keys ADD CONSTRAINT billing_app_keys_purpose_origins_check CHECK (
  (purpose IN ('ENTITLEMENT','SMS_RUNTIME','VOICE_RUNTIME','BROWSER_RUNTIME') AND cardinality(checkout_return_origins) = 0)
  OR (purpose = 'CUSTOMER_LIFECYCLE' AND cardinality(checkout_return_origins) > 0)
);

CREATE TABLE billing_browser_policies (
  id TEXT NOT NULL PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  provider_usd_per_hour DECIMAL(38,18) NOT NULL,
  markup_bps INTEGER NOT NULL DEFAULT 1000,
  minimum_seconds INTEGER NOT NULL DEFAULT 60,
  rounding_seconds INTEGER NOT NULL,
  source_url VARCHAR(1000) NOT NULL,
  valid_until TIMESTAMP(3) NOT NULL,
  retired_at TIMESTAMP(3),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE billing_browser_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_browser_policies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_browser_policies FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT, UPDATE ON billing_browser_policies TO uoa_admin;

CREATE TABLE billing_browser_cancellations (
 dispatch_id UUID PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
 proof TEXT NOT NULL, provider_http_status INTEGER,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((proof='no_provider_dispatch' AND provider_http_status IS NULL)
   OR (proof='provider_rejected' AND provider_http_status IS NOT NULL AND provider_http_status IN (400,401,403,404,422,429)))
);
ALTER TABLE billing_browser_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_browser_cancellations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_browser_cancellations FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT ON billing_browser_cancellations TO uoa_admin;
CREATE TABLE billing_browser_reservations (
  id TEXT NOT NULL PRIMARY KEY,
  dispatch_id UUID NOT NULL UNIQUE,
  binding_digest CHAR(64) NOT NULL,
  service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
  app_key_id TEXT NOT NULL REFERENCES billing_app_keys(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_token_version INTEGER NOT NULL,
  credit_account_id TEXT NOT NULL REFERENCES billing_credit_accounts(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL REFERENCES billing_browser_policies(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  reserved_microcredits BIGINT NOT NULL,
  debited_microcredits BIGINT,
  actual_amount DECIMAL(38,18),
  actual_duration_milliseconds BIGINT,
  provider_session_id UUID UNIQUE,
  provider_started_at TIMESTAMP(3),
  provider_ended_at TIMESTAMP(3),
  provider_status VARCHAR(32),
  proxy_bytes BIGINT,
  dispatch_claimed_at TIMESTAMP(3),
  claim_expires_at TIMESTAMP(3) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'reserved',
  billing_month CHAR(7) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL
);
ALTER TABLE billing_browser_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_browser_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_browser_reservations FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT, UPDATE ON billing_browser_reservations TO uoa_admin;

CREATE UNIQUE INDEX browser_policy_active ON billing_browser_policies(service_id, project_id) WHERE retired_at IS NULL;
CREATE INDEX browser_reservation_credit_state ON billing_browser_reservations(credit_account_id, state);
CREATE INDEX browser_reservation_scope ON billing_browser_reservations(org_id, team_id, billing_month);
ALTER TABLE billing_credit_entries ADD COLUMN browser_reservation_id TEXT UNIQUE
  REFERENCES billing_browser_reservations(id) ON DELETE RESTRICT;
ALTER TABLE billing_browser_policies ADD CONSTRAINT browser_policy_shape CHECK (
  provider_usd_per_hour > 0 AND provider_usd_per_hour <= 1000 AND markup_bps = 1000 AND minimum_seconds = 60
  AND rounding_seconds IN (1,60) AND valid_until > created_at AND source_url LIKE 'https://%');
ALTER TABLE billing_browser_reservations ADD CONSTRAINT browser_reservation_shape CHECK (
  state IN ('reserved','dispatching','settled','released','reconciliation') AND actor_token_version >= 0
  AND max_duration_seconds BETWEEN 60 AND 1800 AND reserved_microcredits > 0
  AND binding_digest ~ '^[a-f0-9]{64}$' AND claim_expires_at > created_at
  AND (debited_microcredits IS NULL OR debited_microcredits BETWEEN 0 AND reserved_microcredits)
  AND (actual_duration_milliseconds IS NULL OR actual_duration_milliseconds >= 0)
  AND (proxy_bytes IS NULL OR proxy_bytes >= 0)
  AND (state NOT IN ('dispatching','settled','reconciliation') OR dispatch_claimed_at IS NOT NULL)
  AND (provider_session_id IS NULL OR (state IN ('settled','reconciliation') AND actual_amount IS NOT NULL
    AND actual_duration_milliseconds IS NOT NULL AND proxy_bytes IS NOT NULL AND provider_status IS NOT NULL
    AND provider_status IN ('COMPLETED','ERROR','TIMED_OUT') AND provider_started_at IS NOT NULL
    AND provider_ended_at IS NOT NULL AND provider_ended_at >= provider_started_at))
  AND (state <> 'settled' OR (debited_microcredits IS NOT NULL AND actual_amount IS NOT NULL
    AND actual_amount > 0 AND provider_session_id IS NOT NULL AND provider_started_at IS NOT NULL
    AND provider_ended_at >= provider_started_at AND provider_status IN ('COMPLETED','ERROR','TIMED_OUT')
    AND proxy_bytes=0 AND actual_duration_milliseconds=extract(epoch FROM (provider_ended_at-provider_started_at))*1000)));
CREATE FUNCTION billing_browser_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed TEXT[]; expected NUMERIC;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Browser financial history is retained' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='billing_browser_policies' THEN
   IF to_jsonb(NEW)-'retired_at' IS DISTINCT FROM to_jsonb(OLD)-'retired_at' OR OLD.retired_at IS NOT NULL THEN
     RAISE EXCEPTION 'Browser tariff is immutable' USING ERRCODE='23514'; END IF;
 ELSE
   allowed:=ARRAY['state','updated_at','provider_session_id','provider_started_at','provider_ended_at','provider_status',
     'proxy_bytes','dispatch_claimed_at','debited_microcredits','actual_amount','actual_duration_milliseconds'];
   IF to_jsonb(NEW)-allowed IS DISTINCT FROM to_jsonb(OLD)-allowed OR OLD.state IN ('settled','released')
      OR (OLD.provider_session_id IS NOT NULL AND ROW(NEW.provider_session_id,NEW.provider_started_at,NEW.provider_ended_at,
        NEW.provider_status,NEW.proxy_bytes,NEW.actual_duration_milliseconds,NEW.actual_amount) IS DISTINCT FROM
        ROW(OLD.provider_session_id,OLD.provider_started_at,OLD.provider_ended_at,OLD.provider_status,OLD.proxy_bytes,
          OLD.actual_duration_milliseconds,OLD.actual_amount))
      OR (OLD.dispatch_claimed_at IS NOT NULL AND NEW.dispatch_claimed_at IS DISTINCT FROM OLD.dispatch_claimed_at)
      OR (OLD.state <> 'reserved' AND NEW.state='reserved') OR (NEW.state='released' AND OLD.provider_session_id IS NOT NULL) THEN
     RAISE EXCEPTION 'Browser payer, tariff, or terminal evidence changed' USING ERRCODE='23514'; END IF;
   IF NEW.state='released' AND NOT EXISTS (SELECT 1 FROM billing_browser_cancellations c
     WHERE c.dispatch_id=NEW.dispatch_id AND c.service_id=NEW.service_id) THEN
     RAISE EXCEPTION 'Browser cancellation proof is required' USING ERRCODE='23514'; END IF;
   IF NEW.provider_session_id IS NOT NULL THEN
     SELECT ceil(p.provider_usd_per_hour * greatest(p.minimum_seconds,
       ceil(NEW.actual_duration_milliseconds::numeric/(p.rounding_seconds*1000))*p.rounding_seconds)
       * 1000000000000000000/3600)/1000000000000000000 INTO expected FROM billing_browser_policies p WHERE p.id=NEW.policy_id;
     IF NEW.actual_amount IS DISTINCT FROM expected OR NEW.actual_duration_milliseconds IS DISTINCT FROM
       (extract(epoch FROM (NEW.provider_ended_at-NEW.provider_started_at))*1000)::bigint THEN
       RAISE EXCEPTION 'Browser receipt does not match the frozen tariff' USING ERRCODE='23514'; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_policy_immutable BEFORE UPDATE OR DELETE ON billing_browser_policies
 FOR EACH ROW EXECUTE FUNCTION billing_browser_record_guard();
CREATE TRIGGER browser_reservation_immutable BEFORE UPDATE OR DELETE ON billing_browser_reservations
 FOR EACH ROW EXECUTE FUNCTION billing_browser_record_guard();
CREATE FUNCTION billing_browser_reservation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM billing_browser_cancellations c WHERE c.dispatch_id=NEW.dispatch_id)
   OR NEW.state <> 'reserved' OR NEW.provider_session_id IS NOT NULL OR NEW.dispatch_claimed_at IS NOT NULL
   OR NOT EXISTS (SELECT 1 FROM billing_browser_policies p
     JOIN billing_app_keys k ON k.id=NEW.app_key_id
     JOIN billing_credit_accounts c ON c.id=NEW.credit_account_id
     JOIN billing_stripe_accounts a ON a.id=c.account_id
     JOIN billing_credit_budget_dispatches b ON b.dispatch_id=NEW.dispatch_id::text
     JOIN teams t ON t.id=NEW.team_id
     WHERE p.id=NEW.policy_id AND p.service_id=NEW.service_id AND p.project_id=NEW.project_id AND p.retired_at IS NULL
       AND p.valid_until > NEW.claim_expires_at + (NEW.max_duration_seconds+60)*interval '1 second'
       AND k.purpose='BROWSER_RUNTIME' AND k.service_id=NEW.service_id AND k.revoked_at IS NULL
       AND c.org_id=NEW.org_id AND t.org_id=NEW.org_id AND a.livemode
       AND b.service_id=NEW.service_id AND b.org_id=NEW.org_id AND b.team_id=NEW.team_id AND b.user_id=NEW.user_id
       AND b.provider_service_id='browserbase' AND b.tariff_id='browser-policy:'||p.id
       AND b.billing_account_id=a.id AND b.frozen_markup_bps=1000 AND b.payment_mode='PREPAID' AND b.status='ACTIVE'
       AND b.reserved_microcredits=NEW.reserved_microcredits) THEN
   RAISE EXCEPTION 'Browser reservation lacks exact paid source and tariff' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_reservation_binding BEFORE INSERT ON billing_browser_reservations
 FOR EACH ROW EXECUTE FUNCTION billing_browser_reservation_binding();
CREATE TRIGGER browser_hold_admission BEFORE INSERT ON billing_browser_reservations
 FOR EACH ROW EXECUTE FUNCTION billing_sms_hold_admission();
CREATE FUNCTION billing_assert_browser_credit_entry(entry billing_credit_entries) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF entry.kind <> 'BROWSER_PREPAID_USAGE' THEN RETURN; END IF;
 IF entry.direction <> 'DEBIT' OR entry.currency <> 'USD' OR entry.ledger_runtime_key_id IS NOT NULL
    OR entry.source_type <> 'browser_provider_receipt' OR entry.browser_reservation_id IS DISTINCT FROM entry.source_id
    OR NOT EXISTS (SELECT 1 FROM billing_browser_reservations r JOIN billing_app_keys k ON k.id=entry.app_key_id
      JOIN billing_paid_usage_liabilities l ON l.dispatch_id=r.dispatch_id::text
      WHERE r.id=entry.browser_reservation_id AND r.state='settled' AND r.credit_account_id=entry.credit_account_id
        AND r.service_id=entry.service_id AND r.user_id=entry.attributed_user_id AND r.debited_microcredits=entry.amount_microcredits
        AND k.service_id=r.service_id AND k.purpose='BROWSER_RUNTIME'
        AND l.receipt_id=r.provider_session_id::text AND l.rated_microcredits=r.debited_microcredits
        AND l.raw_cost_actual=r.actual_amount AND l.credit_account_id=r.credit_account_id
        AND entry.idempotency_key='browser-receipt:'||r.provider_session_id::text) THEN
   RAISE EXCEPTION 'Browser debit requires exact settled provider evidence' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION billing_browser_settlement_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='settled' AND NEW.debited_microcredits > 0 AND NOT EXISTS (
   SELECT 1 FROM billing_credit_entries e WHERE e.browser_reservation_id=NEW.id AND e.kind='BROWSER_PREPAID_USAGE'
     AND e.amount_microcredits=NEW.debited_microcredits) THEN
   RAISE EXCEPTION 'Browser settlement lacks exact debit' USING ERRCODE='23514'; END IF;
 IF NEW.state='settled' AND NOT EXISTS (SELECT 1 FROM billing_paid_usage_liabilities l
   WHERE l.dispatch_id=NEW.dispatch_id::text AND l.receipt_id=NEW.provider_session_id::text
     AND l.credit_account_id=NEW.credit_account_id AND l.rated_microcredits=NEW.debited_microcredits) THEN
   RAISE EXCEPTION 'Browser settlement lacks exact liability' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER browser_settled_debit AFTER INSERT OR UPDATE ON billing_browser_reservations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_browser_settlement_coherence();
ALTER TABLE billing_credit_entries ADD CONSTRAINT browser_entry_binding
 CHECK ((kind='BROWSER_PREPAID_USAGE')=(browser_reservation_id IS NOT NULL));

CREATE OR REPLACE FUNCTION billing_total_reserved_microcredits(account_id TEXT) RETURNS BIGINT
LANGUAGE SQL VOLATILE AS $$
  SELECT COALESCE(SUM(amount),0)::BIGINT FROM (
    SELECT reserved_microcredits AS amount FROM billing_prepaid_reservations
      WHERE credit_account_id = account_id AND status = 'ACTIVE'
    UNION ALL
    SELECT reserved_microcredits FROM billing_sms_reservations
      WHERE credit_account_id = account_id AND state IN ('reserved','dispatching','uncertain','reconciliation')
    UNION ALL
    SELECT reserved_microcredits FROM billing_sms_standing_holds WHERE credit_account_id = account_id
    UNION ALL
    SELECT reserved_microcredits FROM billing_voice_reservations
      WHERE credit_account_id = account_id AND state IN ('reserved','dispatching','uncertain','reconciliation')
    UNION ALL
    SELECT reserved_microcredits FROM billing_browser_reservations
      WHERE credit_account_id = account_id AND state IN ('reserved','dispatching','reconciliation')
  ) held
$$;

CREATE OR REPLACE FUNCTION "billing_credit_entry_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  source_row "billing_credit_entries"%ROWTYPE;
  admin_row "billing_credit_admin_adjustments"%ROWTYPE;
  payment_row "billing_credit_payment_adjustments"%ROWTYPE;
  payment_kind BOOLEAN;
  reversal BOOLEAN;
  signed_delta NUMERIC;
  next_balance NUMERIC;
BEGIN
  SELECT * INTO account_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id" FOR UPDATE;
  IF account_row."id" IS NULL OR account_row."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'credit entry does not match its account' USING ERRCODE = '23514';
  END IF;
  payment_kind := NEW."kind" IN ('REFUND', 'DISPUTE', 'REFUND_REVERSAL', 'DISPUTE_REVERSAL');
  reversal := NEW."kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL');
  IF NEW."kind" = 'ADJUSTMENT' THEN
    SELECT * INTO admin_row FROM "billing_credit_admin_adjustments" WHERE "id" = NEW."source_id";
    IF admin_row."id" IS NULL OR NEW."source_type" <> 'credit_admin_adjustment'
       OR NEW."service_id" IS NOT NULL OR NEW."app_key_id" IS NOT NULL OR NEW."attributed_user_id" IS NOT NULL
       OR admin_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR admin_row."credit_entry_id" IS DISTINCT FROM NEW."id"
       OR admin_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
       OR abs(admin_row."signed_amount_microcredits"::numeric) IS DISTINCT FROM NEW."amount_microcredits"::numeric
       OR NEW."direction" IS DISTINCT FROM (CASE WHEN admin_row."signed_amount_microcredits" > 0
         THEN 'CREDIT'::"BillingCreditEntryDirection" ELSE 'DEBIT'::"BillingCreditEntryDirection" END) THEN
      RAISE EXCEPTION 'admin credit adjustment entry lacks exact immutable evidence' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'BROWSER_PREPAID_USAGE' THEN
    PERFORM billing_assert_browser_credit_entry(NEW);
  ELSIF NEW."kind" = 'VOICE_PREPAID_USAGE' THEN
    PERFORM billing_assert_voice_credit_entry(NEW);
  ELSIF NEW."kind" = 'SMS_PREPAID_USAGE' THEN
    PERFORM billing_assert_sms_credit_entry(NEW);
  ELSIF NEW."kind" = 'PREPAID_USAGE' THEN
    IF NEW."service_id" IS NULL OR NEW."app_key_id" IS NOT NULL
       OR NEW."ledger_runtime_key_id" IS NULL OR NEW."direction" <> 'DEBIT'
       OR NEW."source_type" <> 'prepaid_provider_receipt'
       OR NOT EXISTS (
         SELECT 1 FROM "billing_prepaid_reservations" AS reservation
         WHERE reservation."id" = NEW."source_id"
           AND reservation."status" = 'SETTLED'
           AND reservation."credit_account_id" = NEW."credit_account_id"
           AND reservation."service_id" = NEW."service_id"
           AND reservation."app_key_id" = NEW."ledger_runtime_key_id"
           AND reservation."user_id" = NEW."attributed_user_id"
           AND reservation."currency" = NEW."currency"
           AND reservation."debited_microcredits" = NEW."amount_microcredits"
       ) THEN
      RAISE EXCEPTION 'prepaid debit requires exact settled reservation evidence' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."ledger_runtime_key_id" IS NOT NULL THEN
      RAISE EXCEPTION 'runtime key belongs only to prepaid usage' USING ERRCODE = '23514';
    END IF;
    IF NEW."service_id" IS NULL OR NEW."app_key_id" IS NULL THEN
      RAISE EXCEPTION 'product credit entries require exact service and app-key provenance' USING ERRCODE = '23514';
    END IF;
    IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION') THEN
      PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
    ELSE
      PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
    END IF;
    IF payment_kind THEN
      SELECT * INTO payment_row FROM "billing_credit_payment_adjustments" WHERE "id" = NEW."source_id";
      IF payment_row."id" IS NULL OR NEW."source_type" <> 'credit_payment_adjustment'
         OR payment_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
         OR payment_row."service_id" IS DISTINCT FROM NEW."service_id"
         OR payment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
         OR payment_row."kind"::text IS DISTINCT FROM NEW."kind"::text
         OR payment_row."original_entry_id" IS DISTINCT FROM NEW."reverses_entry_id"
         OR payment_row."credit_entry_id" IS DISTINCT FROM NEW."id"
         OR payment_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
         OR payment_row."amount_microcredits" IS DISTINCT FROM NEW."amount_microcredits" THEN
        RAISE EXCEPTION 'payment adjustment entry lacks exact immutable Stripe evidence' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF payment_kind THEN
    SELECT * INTO source_row FROM "billing_credit_entries"
      WHERE "id" = NEW."reverses_entry_id" FOR KEY SHARE;
    IF source_row."id" IS NULL OR source_row."kind" NOT IN ('TOP_UP', 'AUTOMATIC_TOP_UP')
       OR source_row."direction" <> 'CREDIT'
       OR source_row."credit_account_id" <> NEW."credit_account_id"
       OR source_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR source_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR source_row."attributed_user_id" IS DISTINCT FROM NEW."attributed_user_id"
       OR source_row."currency" <> NEW."currency"
       OR NEW."amount_microcredits" > source_row."amount_microcredits"
       OR (reversal AND NEW."direction" <> 'CREDIT')
       OR (NOT reversal AND NEW."direction" <> 'DEBIT') THEN
      RAISE EXCEPTION 'credit payment adjustment does not match its paid source entry' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."reverses_entry_id" IS NOT NULL THEN
    RAISE EXCEPTION 'only a verified payment adjustment may reference a paid entry' USING ERRCODE = '23514';
  END IF;

  signed_delta := CASE NEW."direction" WHEN 'CREDIT' THEN NEW."amount_microcredits"::numeric
    ELSE -NEW."amount_microcredits"::numeric END;
  next_balance := account_row."balance_microcredits"::numeric + signed_delta;
  IF next_balance < -9223372036854775808 OR next_balance > 9223372036854775807 THEN
    RAISE EXCEPTION 'credit balance exceeds supported precision' USING ERRCODE = '22003';
  END IF;
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION', 'PREPAID_USAGE', 'SMS_PREPAID_USAGE', 'VOICE_PREPAID_USAGE', 'BROWSER_PREPAID_USAGE')
     AND NEW."direction" = 'DEBIT' AND next_balance < 0 THEN
    RAISE EXCEPTION 'rated usage cannot consume more credits than are available' USING ERRCODE = '23514';
  END IF;
  IF NEW."balance_after_microcredits"::numeric <> next_balance THEN
    RAISE EXCEPTION 'credit entry balance-after does not match the locked account balance' USING ERRCODE = '40001';
  END IF;
  UPDATE "billing_credit_accounts"
  SET "balance_microcredits" = next_balance::bigint, "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."credit_account_id";
  RETURN NEW;
END;
$$;

ALTER TABLE "billing_credit_entries"
  DROP CONSTRAINT "billing_credit_entries_kind_check",
  ADD CONSTRAINT "billing_credit_entries_kind_check" CHECK (
    ("kind" IN ('TOP_UP', 'AUTOMATIC_TOP_UP') AND "direction" = 'CREDIT'
      AND "attributed_user_id" IS NOT NULL)
    OR ("kind" = 'USAGE_SETTLEMENT' AND "direction" = 'DEBIT')
    OR ("kind" = 'USAGE_SETTLEMENT_CORRECTION')
    OR ("kind" = 'BROWSER_PREPAID_USAGE' AND "direction"='DEBIT' AND "app_key_id" IS NOT NULL
      AND "ledger_runtime_key_id" IS NULL AND "source_type"='browser_provider_receipt')
    OR ("kind" = 'VOICE_PREPAID_USAGE' AND "direction"='DEBIT' AND "app_key_id" IS NOT NULL
      AND "ledger_runtime_key_id" IS NULL AND "source_type" IN ('voice_provider_receipt','voice_fixed_stream_receipt'))
    OR ("kind" = 'SMS_PREPAID_USAGE' AND "direction" = 'DEBIT'
      AND "app_key_id" IS NOT NULL AND "ledger_runtime_key_id" IS NULL
      AND "source_type" IN ('sms_provider_receipt','sms_inbound_receipt'))
    OR ("kind" = 'PREPAID_USAGE' AND "direction" = 'DEBIT'
      AND "app_key_id" IS NULL AND "ledger_runtime_key_id" IS NOT NULL
      AND "source_type" = 'prepaid_provider_receipt')
    OR ("kind" IN ('REFUND', 'DISPUTE') AND "direction" = 'DEBIT'
      AND "reverses_entry_id" IS NOT NULL AND "source_type" = 'credit_payment_adjustment')
    OR ("kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL') AND "direction" = 'CREDIT'
      AND "reverses_entry_id" IS NOT NULL AND "source_type" = 'credit_payment_adjustment')
    OR ("kind" = 'ADJUSTMENT')
  );

ALTER TABLE billing_credit_entries DROP CONSTRAINT billing_credit_entries_amount_unit_check;
ALTER TABLE billing_credit_entries ADD CONSTRAINT billing_credit_entries_amount_unit_check
 CHECK (kind IN ('PREPAID_USAGE','SMS_PREPAID_USAGE','VOICE_PREPAID_USAGE','BROWSER_PREPAID_USAGE') OR amount_microcredits % 10 = 0);

CREATE OR REPLACE FUNCTION billing_organisation_mode_blockers(p_org text)
RETURNS TABLE(code text, count bigint) LANGUAGE sql STABLE AS $$
  WITH accounts AS (
    SELECT id FROM billing_credit_accounts WHERE org_id = p_org
  ), blockers AS (
    SELECT 'organisation_billing'::text AS code, count(*) FROM billing_org_responsibilities
      WHERE org_id = p_org AND active
    UNION ALL SELECT 'funded_balance', count(*) FROM billing_credit_accounts
      WHERE id IN (SELECT id FROM accounts) AND balance_microcredits <> 0
    UNION ALL SELECT 'automatic_top_up', count(*) FROM billing_credit_accounts
      WHERE id IN (SELECT id FROM accounts) AND auto_top_up_consent_revision_id IS NOT NULL
    UNION ALL SELECT 'subscription', count(*) FROM billing_stripe_subscriptions
      WHERE org_id = p_org
        AND status NOT IN ('canceled', 'incomplete_expired')
    UNION ALL SELECT 'subscription_checkout', count(*) FROM billing_stripe_checkout_sessions
      WHERE org_id = p_org
        AND status NOT IN ('expired', 'complete')
    UNION ALL SELECT 'credit_payment', count(*) FROM billing_credit_top_up_checkouts
      WHERE credit_account_id IN (SELECT id FROM accounts) AND status NOT IN ('COMPLETE', 'EXPIRED')
    UNION ALL SELECT 'card_setup', count(*) FROM billing_credit_setup_checkouts
      WHERE credit_account_id IN (SELECT id FROM accounts) AND status NOT IN ('COMPLETE', 'EXPIRED', 'ABANDONED')
    UNION ALL SELECT 'automatic_payment', count(*) FROM billing_credit_auto_top_up_attempts
      WHERE credit_account_id IN (SELECT id FROM accounts)
        AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')
    UNION ALL SELECT 'addon_subscription', count(*) FROM billing_recurring_addon_subscriptions
      WHERE org_id = p_org
        AND status NOT IN ('canceled', 'incomplete_expired')
    UNION ALL SELECT 'addon_checkout', count(*) FROM billing_recurring_addon_checkouts
      WHERE org_id = p_org
        AND status NOT IN ('COMPLETE', 'EXPIRED')
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_prepaid_reservations
      WHERE org_id = p_org AND status = 'ACTIVE'
    UNION ALL SELECT 'sms_reservation', count(*) FROM billing_sms_reservations
      WHERE org_id = p_org AND state IN ('reserved', 'dispatching', 'uncertain', 'reconciliation')
    UNION ALL SELECT 'sms_standing_funding', count(*) FROM billing_sms_standing_holds
      WHERE org_id = p_org AND state = 'active'
    UNION ALL SELECT 'browser_reservation', count(*) FROM billing_browser_reservations
      WHERE org_id = p_org AND state IN ('reserved','dispatching','reconciliation')
    UNION ALL SELECT 'voice_reservation', count(*) FROM billing_voice_reservations
      WHERE org_id = p_org AND state IN ('reserved', 'dispatching', 'uncertain', 'reconciliation')
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_voice_grants
      WHERE org_id = p_org AND revoked_at IS NULL
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_sms_dispatch_grants
      WHERE org_id = p_org AND revoked_at IS NULL
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_sms_quotes
      WHERE org_id = p_org AND expires_at > current_timestamp
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_credit_usage_settlements
      WHERE credit_account_id IN (SELECT id FROM accounts)
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_paid_usage_liabilities
      WHERE org_id = p_org
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_credit_portfolio_snapshots
      WHERE org_id = p_org
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_ledger_dispatch_decisions d
      WHERE d.org_id = p_org AND d.status = 'PAY_AS_YOU_GO'
        AND NOT EXISTS (SELECT 1 FROM billing_ledger_dispatch_releases r WHERE r.dispatch_id = d.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM billing_paid_usage_liabilities l WHERE l.dispatch_id = d.dispatch_id)
  ) SELECT code, sum(count)::bigint FROM blockers WHERE count > 0 AND code <> 'organisation_billing' GROUP BY code;
$$;
CREATE TRIGGER browser_effect_mode BEFORE INSERT ON billing_browser_reservations
 FOR EACH ROW EXECUTE FUNCTION guard_billing_effect_mode();
