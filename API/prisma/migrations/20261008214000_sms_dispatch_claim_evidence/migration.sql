SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE billing_sms_reservations ADD COLUMN dispatch_claimed_at TIMESTAMP(3);
CREATE FUNCTION billing_sms_claim_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.dispatch_claimed_at IS NOT NULL AND NEW.dispatch_claimed_at IS DISTINCT FROM OLD.dispatch_claimed_at
    OR OLD.dispatch_claimed_at IS NULL AND NEW.dispatch_claimed_at IS NOT NULL AND
      (OLD.state <> 'reserved' OR NEW.state <> 'dispatching') THEN
    RAISE EXCEPTION 'SMS physical claim time is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_claim_identity BEFORE UPDATE ON billing_sms_reservations
  FOR EACH ROW EXECUTE FUNCTION billing_sms_claim_identity();
CREATE OR REPLACE FUNCTION billing_sms_reservation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM billing_sms_dispatch_cancellations WHERE dispatch_id = NEW.dispatch_id) THEN
      RAISE EXCEPTION 'SMS dispatch was canceled before admission' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['state','debited_microcredits','actual_amount','actual_currency',
      'message_sid','dispatch_token_digest','dispatch_claimed_at','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['state','debited_microcredits','actual_amount','actual_currency',
      'message_sid','dispatch_token_digest','dispatch_claimed_at','updated_at'])
      OR (OLD.state IN ('settled','released') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at')
      OR (OLD.message_sid IS NOT NULL AND NEW.message_sid IS DISTINCT FROM OLD.message_sid)
      OR (OLD.dispatch_token_digest IS NOT NULL AND NEW.dispatch_token_digest IS DISTINCT FROM OLD.dispatch_token_digest)
      OR (OLD.state = 'reserved' AND NEW.state NOT IN ('reserved','dispatching','released'))
      OR (OLD.state <> 'reserved' AND NEW.state = 'reserved') THEN
      RAISE EXCEPTION 'SMS dispatch identity or terminal outcome cannot change' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
