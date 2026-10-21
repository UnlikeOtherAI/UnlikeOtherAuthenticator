SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE FUNCTION billing_voice_admission_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state <> 'reserved' OR NEW.dispatch_claimed_at IS NOT NULL OR NEW.dispatch_token_digest IS NOT NULL OR
    NEW.debited_microcredits IS NOT NULL OR NEW.actual_amount IS NOT NULL OR
    NOT EXISTS (
      SELECT 1 FROM billing_voice_grants g JOIN billing_voice_quotes q ON q.grant_id=g.id
      JOIN billing_sms_number_resources n ON n.id=g.number_id
      JOIN billing_credit_budget_dispatches b ON b.dispatch_id=NEW.dispatch_id
      WHERE g.id=NEW.grant_id AND q.id=NEW.quote_id AND g.revoked_at IS NULL AND
       g.service_id=NEW.service_id AND g.org_id=NEW.org_id AND g.team_id=NEW.team_id AND g.user_id=NEW.user_id AND
       g.number_id=NEW.number_id AND g.allocation_id=NEW.allocation_id AND g.direction=NEW.direction AND
       q.service_id=NEW.service_id AND q.account_sid=NEW.account_sid AND q."from"=NEW."from" AND q."to"=NEW."to" AND
       q.max_duration_seconds=NEW.max_duration_seconds AND q.reserved_microcredits=NEW.reserved_microcredits AND
       q.expires_at=NEW.claim_expires_at AND q.expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND
       n.state='active' AND n.account_sid=NEW.account_sid AND n.org_id=NEW.org_id AND n.service_id=NEW.service_id AND
       n.phone_number=CASE WHEN NEW.direction='inbound' THEN NEW."to" ELSE NEW."from" END AND
       b.service_id=NEW.service_id AND b.org_id=NEW.org_id AND b.team_id=NEW.team_id AND b.user_id=NEW.user_id AND
       b.tariff_id='voice-quote:'||q.id AND b.frozen_markup_bps=q.markup_bps AND b.payment_mode='PREPAID' AND b.status='ACTIVE' AND
       b.provider_service_id='twilio-voice' AND b.reserved_microcredits=q.reserved_microcredits
    ) THEN RAISE EXCEPTION 'Voice admission lacks exact authority and budget binding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER voice_admission_binding BEFORE INSERT ON billing_voice_reservations
 FOR EACH ROW EXECUTE FUNCTION billing_voice_admission_binding();
