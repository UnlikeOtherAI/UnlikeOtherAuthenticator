BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE billing_sms_number_resources ADD COLUMN sms_capable BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE billing_sms_monthly_prices ADD COLUMN number_type VARCHAR(16) NOT NULL DEFAULT 'mobile'
  CHECK (number_type IN ('mobile', 'local', 'national', 'toll-free'));
ALTER TABLE billing_sms_route_policies ADD COLUMN number_type VARCHAR(16) NOT NULL DEFAULT 'mobile'
  CHECK (number_type IN ('mobile', 'local', 'national', 'toll-free')),
  ADD CONSTRAINT sms_nonmobile_route_manual CHECK (number_type = 'mobile' OR provider_price IS NULL);
ALTER TABLE billing_sms_quotes ADD COLUMN number_type VARCHAR(16) NOT NULL DEFAULT 'mobile'
  CHECK (number_type IN ('mobile', 'local', 'national', 'toll-free'));
ALTER TABLE billing_sms_quotes DROP CONSTRAINT sms_quote_shape,
  ADD CONSTRAINT sms_quote_shape CHECK (
    provider_amount >= 0 AND final_amount >= 0 AND final_currency IN ('USD', 'EUR', 'GBP')
    AND (direction = 'monthly' OR final_currency = 'USD')
    AND country ~ '^[A-Z]{2}$'
    AND ((direction = 'monthly' AND destination IS NULL AND rate_basis = CASE WHEN number_type = 'mobile' THEN 'monthly_mobile' ELSE 'monthly_number' END)
      OR (direction = 'inbound' AND destination IS NULL AND rate_basis = CASE WHEN number_type = 'mobile' THEN 'inbound_mobile' ELSE 'inbound_number' END)
      OR (direction = 'outbound' AND destination ~ '^\+[1-9][0-9]{6,14}$'
        AND rate_basis = CASE WHEN number_type = 'mobile' THEN 'maximum_mobile_carrier' ELSE 'maximum_number_carrier' END)));

-- Provider ownership verification can refresh capabilities on the same bound number.
CREATE OR REPLACE FUNCTION billing_sms_number_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM billing_sms_resource_cancellations WHERE resource_id = NEW.id) THEN
      RAISE EXCEPTION 'SMS resource was canceled before admission' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['state','recovery_reason','account_sid','phone_number_sid','checkout_id',
      'refund_evidence_digest','refunded_at','updated_at','sms_capable']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['state','recovery_reason','account_sid','phone_number_sid','checkout_id',
      'refund_evidence_digest','refunded_at','updated_at','sms_capable'])
      OR (OLD.phone_number_sid IS NOT NULL AND (NEW.phone_number_sid IS DISTINCT FROM OLD.phone_number_sid
        OR NEW.account_sid IS DISTINCT FROM OLD.account_sid))
      OR (NEW.sms_capable IS DISTINCT FROM OLD.sms_capable AND
        (NEW.state <> 'active' OR NEW.account_sid IS NULL OR NEW.phone_number_sid IS NULL))
      OR (OLD.state = 'ended' AND NEW.state <> 'ended')
      OR (OLD.state = 'refund_required' AND NEW.state NOT IN ('refund_required','ended'))
      OR (OLD.refund_evidence_digest IS NOT NULL AND
        (NEW.refund_evidence_digest IS DISTINCT FROM OLD.refund_evidence_digest
          OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at)) THEN
      RAISE EXCEPTION 'SMS number financial identity cannot change' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'refund_required' AND NEW.state = 'ended'
      AND (NEW.refund_evidence_digest IS NULL OR NEW.refunded_at IS NULL) THEN
      RAISE EXCEPTION 'SMS refund completion requires verified evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
