SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Browser anomalies share the existing reviewed, immutable provider-exception ledger.
ALTER TABLE billing_paid_usage_exceptions ALTER COLUMN runtime_key_id DROP NOT NULL;
ALTER TABLE billing_paid_usage_exceptions ADD COLUMN app_key_id TEXT
 REFERENCES billing_app_keys(id) ON DELETE RESTRICT;
ALTER TABLE billing_paid_usage_exceptions ADD CONSTRAINT paid_exception_one_authority
 CHECK ((runtime_key_id IS NULL) <> (app_key_id IS NULL));
CREATE FUNCTION billing_browser_collectible(dispatch TEXT, gross BIGINT, proxy BIGINT)
 RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE exception billing_paid_usage_exceptions;
BEGIN
 SELECT * INTO exception FROM billing_paid_usage_exceptions WHERE dispatch_id=dispatch;
 IF FOUND THEN
   IF exception.status <> 'WRITTEN_OFF' OR exception.app_key_id IS NULL
     OR exception.gross_rated_microcredits <> gross
     OR exception.collectible_microcredits < 0 OR exception.waived_microcredits < 0
     OR exception.collectible_microcredits + exception.waived_microcredits <> gross
     OR NOT EXISTS (SELECT 1 FROM billing_browser_reservations r WHERE r.dispatch_id::text=dispatch
       AND r.app_key_id=exception.app_key_id AND r.provider_session_id::text=exception.receipt_id
       AND r.actual_amount=exception.raw_cost_actual
       AND exception.collectible_microcredits=least(gross,r.reserved_microcredits)) THEN
       RAISE EXCEPTION 'Browser waiver does not match receipt evidence' USING ERRCODE='23514';
   END IF;
   RETURN exception.collectible_microcredits;
 END IF;
 IF proxy <> 0 THEN RAISE EXCEPTION 'Unexpected proxy usage needs operator review' USING ERRCODE='23514'; END IF;
 RETURN gross;
END $$;
ALTER TABLE billing_browser_reservations DROP CONSTRAINT browser_reservation_shape;
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
    AND actual_duration_milliseconds=extract(epoch FROM (provider_ended_at-provider_started_at))*1000)));
CREATE OR REPLACE FUNCTION billing_assert_browser_credit_entry(entry billing_credit_entries) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF entry.kind <> 'BROWSER_PREPAID_USAGE' THEN RETURN; END IF;
 IF entry.direction <> 'DEBIT' OR entry.currency <> 'USD' OR entry.ledger_runtime_key_id IS NOT NULL
    OR entry.source_type <> 'browser_provider_receipt' OR entry.browser_reservation_id IS DISTINCT FROM entry.source_id
    OR NOT EXISTS (SELECT 1 FROM billing_browser_reservations r JOIN billing_app_keys k ON k.id=entry.app_key_id
      JOIN billing_paid_usage_liabilities l ON l.dispatch_id=r.dispatch_id::text
      WHERE r.id=entry.browser_reservation_id AND r.state='settled' AND r.credit_account_id=entry.credit_account_id
        AND r.service_id=entry.service_id AND r.user_id=entry.attributed_user_id AND r.debited_microcredits=entry.amount_microcredits
        AND k.service_id=r.service_id AND k.purpose='BROWSER_RUNTIME'
        AND l.receipt_id=r.provider_session_id::text AND billing_browser_collectible(r.dispatch_id::text, l.rated_microcredits, r.proxy_bytes)=r.debited_microcredits
        AND l.raw_cost_actual=r.actual_amount AND l.credit_account_id=r.credit_account_id
        AND entry.idempotency_key='browser-receipt:'||r.provider_session_id::text) THEN
   RAISE EXCEPTION 'Browser debit requires exact settled provider evidence' USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION billing_browser_settlement_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='settled' AND NEW.debited_microcredits > 0 AND NOT EXISTS (
   SELECT 1 FROM billing_credit_entries e WHERE e.browser_reservation_id=NEW.id AND e.kind='BROWSER_PREPAID_USAGE'
     AND e.amount_microcredits=NEW.debited_microcredits) THEN
   RAISE EXCEPTION 'Browser settlement lacks exact debit' USING ERRCODE='23514'; END IF;
 IF NEW.state='settled' AND NOT EXISTS (SELECT 1 FROM billing_paid_usage_liabilities l
   WHERE l.dispatch_id=NEW.dispatch_id::text AND l.receipt_id=NEW.provider_session_id::text
     AND l.credit_account_id=NEW.credit_account_id AND billing_browser_collectible(NEW.dispatch_id::text, l.rated_microcredits, NEW.proxy_bytes)=NEW.debited_microcredits) THEN
   RAISE EXCEPTION 'Browser settlement lacks exact liability' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
