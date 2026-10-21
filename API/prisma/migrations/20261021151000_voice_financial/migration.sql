SET lock_timeout = '5s';

SET statement_timeout = '120s';

CREATE TABLE billing_voice_grants (
  "id" VARCHAR(160) NOT NULL PRIMARY KEY,
  "service_id" TEXT NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "actor_token_version" INTEGER NOT NULL,
  "number_id" VARCHAR(160) NOT NULL,
  "allocation_id" VARCHAR(160) NOT NULL,
  "delegate_id" VARCHAR(160) NOT NULL,
  "direction" VARCHAR(10) NOT NULL,
  "purpose" VARCHAR(20) NOT NULL,
  "max_duration_seconds" INTEGER NOT NULL,
  "max_concurrent_calls" INTEGER NOT NULL,
  "destinations" TEXT[] NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE billing_voice_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_voice_grants FORCE ROW LEVEL SECURITY;

REVOKE ALL ON billing_voice_grants FROM PUBLIC, uoa_app;

GRANT SELECT, INSERT, UPDATE ON billing_voice_grants TO uoa_admin;

CREATE TABLE billing_voice_quotes (
  "id" TEXT NOT NULL PRIMARY KEY,
  "service_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "account_sid" CHAR(34) NOT NULL,
  "from" VARCHAR(16) NOT NULL,
  "to" VARCHAR(16) NOT NULL,
  "direction" VARCHAR(10) NOT NULL,
  "max_duration_seconds" INTEGER NOT NULL,
  "raw_cost_bound" DECIMAL(38,18) NOT NULL,
  "markup_bps" INTEGER NOT NULL,
  "reserved_microcredits" BIGINT NOT NULL,
  "provider_evidence" JSONB NOT NULL,
  "policy_evidence" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE billing_voice_quotes ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_voice_quotes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON billing_voice_quotes FROM PUBLIC, uoa_app;

GRANT SELECT, INSERT, UPDATE ON billing_voice_quotes TO uoa_admin;

CREATE TABLE billing_voice_reservations (
  "id" TEXT NOT NULL PRIMARY KEY,
  "dispatch_id" VARCHAR(160) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "binding_digest" CHAR(64) NOT NULL,
  "service_id" TEXT NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "credit_account_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "quote_id" TEXT NOT NULL,
  "number_id" VARCHAR(160) NOT NULL,
  "allocation_id" VARCHAR(160) NOT NULL,
  "account_sid" CHAR(34) NOT NULL,
  "from" VARCHAR(16) NOT NULL,
  "to" VARCHAR(16) NOT NULL,
  "direction" VARCHAR(10) NOT NULL,
  "conversation_id" VARCHAR(160) NOT NULL,
  "leg_id" VARCHAR(160) NOT NULL,
  "parent_reservation_id" TEXT,
  "max_duration_seconds" INTEGER NOT NULL,
  "call_sid" CHAR(34),
  "reserved_microcredits" BIGINT NOT NULL,
  "debited_microcredits" BIGINT,
  "actual_amount" DECIMAL(38,18),
  "actual_duration_seconds" INTEGER,
  "dispatch_token_digest" CHAR(64),
  "dispatch_claimed_at" TIMESTAMP(3),
  "claim_expires_at" TIMESTAMP(3) NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'reserved',
  "billing_month" CHAR(7) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

ALTER TABLE billing_voice_reservations ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_voice_reservations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON billing_voice_reservations FROM PUBLIC, uoa_app;

GRANT SELECT, INSERT, UPDATE ON billing_voice_reservations TO uoa_admin;

ALTER TABLE billing_credit_entries ADD COLUMN voice_reservation_id TEXT UNIQUE REFERENCES billing_voice_reservations(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX voice_dispatch_id ON billing_voice_reservations(dispatch_id);

CREATE UNIQUE INDEX voice_call_sid ON billing_voice_reservations(account_sid,call_sid);

CREATE UNIQUE INDEX voice_leg_id ON billing_voice_reservations(service_id,conversation_id,leg_id);

CREATE INDEX voice_credit_state ON billing_voice_reservations(credit_account_id,state);

CREATE INDEX voice_grant_state ON billing_voice_reservations(grant_id,state);

ALTER TABLE billing_voice_grants ADD FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_grants ADD FOREIGN KEY (app_key_id) REFERENCES billing_app_keys(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_grants ADD FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_grants ADD FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_grants ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_grants ADD FOREIGN KEY (number_id) REFERENCES billing_sms_number_resources(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_quotes ADD FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_quotes ADD FOREIGN KEY (grant_id) REFERENCES billing_voice_grants(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (app_key_id) REFERENCES billing_app_keys(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (number_id) REFERENCES billing_sms_number_resources(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (grant_id) REFERENCES billing_voice_grants(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (quote_id) REFERENCES billing_voice_quotes(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (credit_account_id) REFERENCES billing_credit_accounts(id) ON DELETE RESTRICT;

ALTER TABLE billing_voice_reservations ADD FOREIGN KEY (parent_reservation_id) REFERENCES billing_voice_reservations(id) ON DELETE RESTRICT;

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
  ) held
$$;



CREATE TRIGGER voice_hold_admission BEFORE INSERT ON billing_voice_reservations FOR EACH ROW EXECUTE FUNCTION billing_sms_hold_admission();
ALTER TABLE billing_voice_grants ADD CONSTRAINT voice_grant_shape CHECK (
 direction IN ('inbound','outbound') AND purpose IN ('agent_call','human_transfer') AND
 max_duration_seconds BETWEEN 1 AND 14400 AND max_concurrent_calls BETWEEN 1 AND 20 AND actor_token_version >= 0 AND
 ((direction='inbound' AND cardinality(destinations)=0 AND purpose='agent_call') OR
  (direction='outbound' AND cardinality(destinations) BETWEEN 1 AND 100)));
ALTER TABLE billing_voice_quotes ADD CONSTRAINT voice_quote_shape CHECK (
 direction IN ('inbound','outbound') AND max_duration_seconds BETWEEN 1 AND 14400 AND
 raw_cost_bound >= 0 AND reserved_microcredits >= 0 AND markup_bps >= 0 AND expires_at > created_at);
ALTER TABLE billing_voice_reservations ADD CONSTRAINT voice_reservation_shape CHECK (
 state IN ('reserved','dispatching','uncertain','settled','released','reconciliation') AND
 direction IN ('inbound','outbound') AND max_duration_seconds BETWEEN 1 AND 14400 AND reserved_microcredits >= 0 AND
 (debited_microcredits IS NULL OR debited_microcredits BETWEEN 0 AND reserved_microcredits) AND
 account_sid ~ '^AC[0-9a-fA-F]{32}$' AND (call_sid IS NULL OR call_sid ~ '^CA[0-9a-fA-F]{32}$') AND
 request_fingerprint ~ '^[a-f0-9]{64}$' AND binding_digest ~ '^[a-f0-9]{64}$' AND
 (state <> 'settled' OR (debited_microcredits IS NOT NULL AND actual_amount IS NOT NULL AND call_sid IS NOT NULL)));
CREATE FUNCTION billing_voice_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed TEXT[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Voice financial history is retained' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='billing_voice_quotes' THEN RAISE EXCEPTION 'Voice quote is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='billing_voice_grants' THEN
   IF to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at' OR OLD.revoked_at IS NOT NULL THEN
     RAISE EXCEPTION 'Voice grant is immutable' USING ERRCODE='23514';
   END IF;
 ELSE
   allowed:=ARRAY['state','updated_at','call_sid','dispatch_token_digest','dispatch_claimed_at','debited_microcredits','actual_amount','actual_duration_seconds'];
   IF to_jsonb(NEW)-allowed IS DISTINCT FROM to_jsonb(OLD)-allowed OR OLD.state IN ('settled','released') OR
      (OLD.call_sid IS NOT NULL AND NEW.call_sid IS DISTINCT FROM OLD.call_sid) OR
      (OLD.dispatch_claimed_at IS NOT NULL AND (NEW.dispatch_claimed_at IS DISTINCT FROM OLD.dispatch_claimed_at OR
        NEW.dispatch_token_digest IS DISTINCT FROM OLD.dispatch_token_digest)) OR
      (OLD.state <> 'reserved' AND NEW.state='reserved') OR
      (NEW.state='dispatching' AND NEW.dispatch_claimed_at IS NULL) THEN
     RAISE EXCEPTION 'Voice reservation binding or terminal evidence changed' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER voice_quote_immutable BEFORE UPDATE OR DELETE ON billing_voice_quotes FOR EACH ROW EXECUTE FUNCTION billing_voice_record_guard();
CREATE TRIGGER voice_grant_immutable BEFORE UPDATE OR DELETE ON billing_voice_grants FOR EACH ROW EXECUTE FUNCTION billing_voice_record_guard();
CREATE TRIGGER voice_reservation_immutable BEFORE UPDATE OR DELETE ON billing_voice_reservations FOR EACH ROW EXECUTE FUNCTION billing_voice_record_guard();
CREATE FUNCTION billing_assert_voice_credit_entry(entry billing_credit_entries) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF entry.kind <> 'VOICE_PREPAID_USAGE' THEN RETURN; END IF;
 IF entry.direction <> 'DEBIT' OR entry.currency <> 'USD' OR entry.ledger_runtime_key_id IS NOT NULL OR
    entry.source_type <> 'voice_provider_receipt' OR entry.voice_reservation_id IS DISTINCT FROM entry.source_id OR
    NOT EXISTS (SELECT 1 FROM billing_voice_reservations r JOIN billing_app_keys k ON k.id=entry.app_key_id
     WHERE r.id=entry.voice_reservation_id AND r.state='settled' AND r.credit_account_id=entry.credit_account_id AND
       r.service_id=entry.service_id AND r.user_id=entry.attributed_user_id AND r.debited_microcredits=entry.amount_microcredits AND
       k.service_id=r.service_id AND k.purpose='VOICE_RUNTIME' AND
       entry.idempotency_key='voice-receipt:'||r.account_sid||':'||r.call_sid) THEN
   RAISE EXCEPTION 'Voice debit requires exact settled provider evidence' USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION billing_voice_settlement_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='settled' AND NEW.debited_microcredits > 0 AND NOT EXISTS (
   SELECT 1 FROM billing_credit_entries e WHERE e.voice_reservation_id=NEW.id AND e.kind='VOICE_PREPAID_USAGE'
     AND e.amount_microcredits=NEW.debited_microcredits) THEN
   RAISE EXCEPTION 'Voice settlement lacks exact debit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER voice_settled_debit AFTER INSERT OR UPDATE ON billing_voice_reservations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_voice_settlement_coherence();
ALTER TABLE billing_credit_entries ADD CONSTRAINT voice_entry_binding CHECK ((kind='VOICE_PREPAID_USAGE')=(voice_reservation_id IS NOT NULL));

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
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION', 'PREPAID_USAGE', 'SMS_PREPAID_USAGE', 'VOICE_PREPAID_USAGE')
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
    OR ("kind" = 'VOICE_PREPAID_USAGE' AND "direction"='DEBIT' AND "app_key_id" IS NOT NULL
      AND "ledger_runtime_key_id" IS NULL AND "source_type"='voice_provider_receipt')
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
 CHECK (kind IN ('PREPAID_USAGE','SMS_PREPAID_USAGE','VOICE_PREPAID_USAGE') OR amount_microcredits % 10 = 0);
