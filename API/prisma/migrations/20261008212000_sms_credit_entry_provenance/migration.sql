SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE FUNCTION billing_assert_sms_credit_entry(entry billing_credit_entries) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF entry.kind <> 'SMS_PREPAID_USAGE' THEN RETURN; END IF;
  IF entry.direction <> 'DEBIT' OR entry.currency <> 'USD' OR entry.ledger_runtime_key_id IS NOT NULL
    OR entry.prepaid_reservation_id IS NOT NULL OR entry.reverses_entry_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM billing_app_keys key JOIN billing_services service ON service.id = key.service_id
      WHERE key.id = entry.app_key_id AND key.service_id = entry.service_id AND key.purpose = 'SMS_RUNTIME') THEN
    RAISE EXCEPTION 'SMS debit requires dedicated product runtime provenance' USING ERRCODE = '23514';
  END IF;
  IF entry.sms_reservation_id IS NOT NULL AND entry.sms_inbound_receipt_id IS NULL THEN
    IF entry.source_type <> 'sms_provider_receipt' OR entry.source_id <> entry.sms_reservation_id
      OR NOT EXISTS (SELECT 1 FROM billing_sms_reservations row WHERE row.id = entry.sms_reservation_id
        AND row.state = 'settled' AND row.credit_account_id = entry.credit_account_id
        AND row.service_id = entry.service_id AND row.user_id = entry.attributed_user_id
        AND row.debited_microcredits = entry.amount_microcredits AND row.actual_amount IS NOT NULL
        AND row.actual_currency IS NOT NULL AND row.message_sid IS NOT NULL) THEN
      RAISE EXCEPTION 'SMS debit requires exact settled receipt evidence' USING ERRCODE = '23514';
    END IF;
  ELSIF entry.sms_inbound_receipt_id IS NOT NULL AND entry.sms_reservation_id IS NULL THEN
    IF entry.source_type <> 'sms_inbound_receipt' OR entry.source_id <> entry.sms_inbound_receipt_id
      OR NOT EXISTS (SELECT 1 FROM billing_sms_inbound_receipts row
        JOIN billing_sms_standing_holds hold ON hold.id = row.standing_hold_id
        WHERE row.id = entry.sms_inbound_receipt_id AND row.state = 'funded'
        AND hold.credit_account_id = entry.credit_account_id AND row.service_id = entry.service_id
        AND hold.requested_by_user_id = entry.attributed_user_id
        AND row.consumed_microcredits = entry.amount_microcredits
        AND row.actual_amount IS NOT NULL AND row.actual_currency IS NOT NULL) THEN
      RAISE EXCEPTION 'Inbound SMS debit requires exact funded receipt evidence' USING ERRCODE = '23514';
    END IF;
  ELSE RAISE EXCEPTION 'SMS debit requires exactly one receipt source' USING ERRCODE = '23514'; END IF;
END $$;

CREATE FUNCTION billing_sms_credit_entry_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM billing_assert_sms_credit_entry(NEW); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER sms_credit_entry_source_coherence AFTER INSERT ON billing_credit_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_sms_credit_entry_coherence();

ALTER TABLE billing_credit_entries DROP CONSTRAINT billing_credit_entries_amount_unit_check;
ALTER TABLE billing_credit_entries ADD CONSTRAINT billing_credit_entries_amount_unit_check
  CHECK (kind IN ('PREPAID_USAGE','SMS_PREPAID_USAGE') OR amount_microcredits % 10 = 0);
ALTER TABLE billing_credit_entries ADD CONSTRAINT sms_entry_source_binding CHECK (
  (kind = 'SMS_PREPAID_USAGE' AND ((sms_reservation_id IS NULL) <> (sms_inbound_receipt_id IS NULL)))
  OR (kind <> 'SMS_PREPAID_USAGE' AND sms_reservation_id IS NULL AND sms_inbound_receipt_id IS NULL));

CREATE FUNCTION billing_sms_terminal_receipt_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'billing_sms_reservations' THEN
    IF NEW.state = 'settled' AND NEW.debited_microcredits = 0 AND EXISTS (
      SELECT 1 FROM billing_paid_usage_liabilities liability WHERE liability.dispatch_id = NEW.dispatch_id
        AND liability.rated_microcredits = 0 AND liability.credit_account_id = NEW.credit_account_id) THEN RETURN NULL; END IF;
    IF NEW.state = 'settled' AND NOT EXISTS (SELECT 1 FROM billing_credit_entries entry
      WHERE entry.sms_reservation_id = NEW.id AND entry.kind = 'SMS_PREPAID_USAGE'
        AND entry.amount_microcredits = NEW.debited_microcredits) THEN
      RAISE EXCEPTION 'SMS settled receipt must commit with its exact wallet debit' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'funded' AND NEW.consumed_microcredits = 0 AND EXISTS (
    SELECT 1 FROM billing_paid_usage_liabilities liability
      WHERE liability.dispatch_id = 'sms-inbound:' || NEW.account_sid || ':' || NEW.message_sid
        AND liability.rated_microcredits = 0) THEN RETURN NULL;
  ELSIF NEW.state = 'funded' AND NOT EXISTS (SELECT 1 FROM billing_credit_entries entry
    WHERE entry.sms_inbound_receipt_id = NEW.id AND entry.kind = 'SMS_PREPAID_USAGE'
      AND entry.amount_microcredits = NEW.consumed_microcredits) THEN
    RAISE EXCEPTION 'Inbound funded receipt must commit with its exact wallet debit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sms_settled_debit_coherence AFTER INSERT OR UPDATE ON billing_sms_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_sms_terminal_receipt_coherence();
CREATE CONSTRAINT TRIGGER sms_funded_debit_coherence AFTER INSERT OR UPDATE ON billing_sms_inbound_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_sms_terminal_receipt_coherence();

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
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION', 'PREPAID_USAGE', 'SMS_PREPAID_USAGE')
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

ALTER TABLE "billing_credit_entries"
  DROP CONSTRAINT "billing_credit_entries_provenance_check",
  ADD CONSTRAINT "billing_credit_entries_provenance_check" CHECK (
    ("kind" = 'ADJUSTMENT' AND "service_id" IS NULL AND "app_key_id" IS NULL
      AND "ledger_runtime_key_id" IS NULL AND "attributed_user_id" IS NULL
      AND "source_type" = 'credit_admin_adjustment')
    OR ("kind" = 'PREPAID_USAGE' AND "service_id" IS NOT NULL
      AND "app_key_id" IS NULL AND "ledger_runtime_key_id" IS NOT NULL
      AND "attributed_user_id" IS NOT NULL
      AND "source_type" = 'prepaid_provider_receipt')
    OR ("kind" NOT IN ('ADJUSTMENT', 'PREPAID_USAGE') AND "service_id" IS NOT NULL
      AND "app_key_id" IS NOT NULL AND "ledger_runtime_key_id" IS NULL
      AND "source_type" <> 'credit_admin_adjustment')
  );
