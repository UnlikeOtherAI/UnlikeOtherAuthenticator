SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_voice_quotes ADD COLUMN stream_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE billing_voice_streams (
 id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES billing_voice_reservations(id) ON DELETE RESTRICT,
 service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
 account_sid CHAR(34) NOT NULL, call_sid CHAR(34) NOT NULL, stream_sid CHAR(34) NOT NULL,
 started_at TIMESTAMP(3) NOT NULL, stopped_at TIMESTAMP(3), billed_minutes INTEGER,
 fixed_amount DECIMAL(38,18), created_at TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
 UNIQUE(account_sid, stream_sid),
 CHECK (stream_sid ~ '^MZ[a-fA-F0-9]{32}$'),
 CHECK ((stopped_at IS NULL AND billed_minutes IS NULL AND fixed_amount IS NULL) OR
   (stopped_at >= started_at AND billed_minutes >= 1 AND fixed_amount >= 0))
);
CREATE INDEX billing_voice_streams_scope ON billing_voice_streams(service_id, account_sid, started_at);
CREATE TABLE billing_voice_stream_invoices (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
 account_sid CHAR(34) NOT NULL, billing_month CHAR(7) NOT NULL,
 amount DECIMAL(38,18) NOT NULL CHECK(amount >= 0), reference VARCHAR(160) NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);
CREATE INDEX billing_voice_stream_invoice_scope ON billing_voice_stream_invoices(service_id, account_sid, billing_month, created_at);
ALTER TABLE billing_voice_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_voice_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_voice_stream_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_voice_stream_invoices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_voice_streams, billing_voice_stream_invoices FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT, UPDATE ON billing_voice_streams TO uoa_admin;
GRANT SELECT, INSERT ON billing_voice_stream_invoices TO uoa_admin;
CREATE FUNCTION billing_voice_stream_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.stopped_at IS NOT NULL THEN RAISE EXCEPTION 'Voice stream start must precede stop' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Voice stream evidence is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['stopped_at','billed_minutes','fixed_amount']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['stopped_at','billed_minutes','fixed_amount']) OR OLD.stopped_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Voice stream evidence is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM billing_voice_reservations r JOIN billing_voice_quotes q ON q.id=r.quote_id
   WHERE r.id=NEW.reservation_id AND r.service_id=NEW.service_id AND r.account_sid=NEW.account_sid AND r.call_sid=NEW.call_sid
   AND r.dispatch_claimed_at IS NOT NULL AND r.state IN ('dispatching','uncertain','reconciliation')
   AND q.stream_enabled AND q.policy_evidence->>'featureProfile'='media_streams_fixed'
   AND (NEW.stopped_at IS NULL OR (NEW.billed_minutes=GREATEST(1,ceil(extract(epoch FROM (NEW.stopped_at-NEW.started_at))/60))
     AND NEW.fixed_amount=NEW.billed_minutes*(q.policy_evidence->>'streamPricePerMinute')::numeric))) THEN
   RAISE EXCEPTION 'Voice stream lacks exact reservation binding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER voice_stream_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_voice_streams
 FOR EACH ROW EXECUTE FUNCTION billing_voice_stream_guard();
CREATE FUNCTION billing_voice_stream_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Voice stream invoice evidence is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER voice_stream_invoice_guard BEFORE UPDATE OR DELETE ON billing_voice_stream_invoices
 FOR EACH ROW EXECUTE FUNCTION billing_voice_stream_invoice_guard();
CREATE OR REPLACE FUNCTION billing_assert_voice_credit_entry(entry billing_credit_entries) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF entry.kind <> 'VOICE_PREPAID_USAGE' THEN RETURN; END IF;
 IF entry.direction <> 'DEBIT' OR entry.currency <> 'USD' OR entry.ledger_runtime_key_id IS NOT NULL OR
    entry.voice_reservation_id IS DISTINCT FROM entry.source_id OR
    NOT EXISTS (SELECT 1 FROM billing_voice_reservations r JOIN billing_app_keys k ON k.id=entry.app_key_id
     JOIN billing_voice_quotes q ON q.id=r.quote_id
     WHERE r.id=entry.voice_reservation_id AND r.state='settled' AND r.credit_account_id=entry.credit_account_id AND
       r.service_id=entry.service_id AND r.user_id=entry.attributed_user_id AND r.debited_microcredits=entry.amount_microcredits AND
       k.service_id=r.service_id AND k.purpose='VOICE_RUNTIME' AND
       entry.source_type=CASE WHEN q.stream_enabled THEN 'voice_fixed_stream_receipt' ELSE 'voice_provider_receipt' END AND
       (NOT q.stream_enabled OR EXISTS(SELECT 1 FROM billing_voice_streams s WHERE s.reservation_id=r.id AND s.stopped_at IS NOT NULL)) AND
       entry.idempotency_key='voice-receipt:'||r.account_sid||':'||r.call_sid) THEN
   RAISE EXCEPTION 'Voice debit requires exact settled call and tariff evidence' USING ERRCODE='23514';
 END IF;
END $$;

ALTER TABLE "billing_credit_entries"
  DROP CONSTRAINT "billing_credit_entries_kind_check",
  ADD CONSTRAINT "billing_credit_entries_kind_check" CHECK (
    ("kind" IN ('TOP_UP', 'AUTOMATIC_TOP_UP') AND "direction" = 'CREDIT'
      AND "attributed_user_id" IS NOT NULL)
    OR ("kind" = 'USAGE_SETTLEMENT' AND "direction" = 'DEBIT')
    OR ("kind" = 'USAGE_SETTLEMENT_CORRECTION')
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
