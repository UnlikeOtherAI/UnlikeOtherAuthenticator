-- Prisma timestamp columns store UTC without a time zone.
CREATE OR REPLACE FUNCTION telephone_sms_reservation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challenge telephone_call_challenges%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.telephone_call_challenge_id IS DISTINCT FROM NEW.telephone_call_challenge_id THEN
      RAISE EXCEPTION 'Telephone SMS challenge binding is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.telephone_call_challenge_id IS NOT NULL THEN
    SELECT * INTO challenge FROM telephone_call_challenges WHERE id = NEW.telephone_call_challenge_id;
    IF NOT FOUND OR challenge.app_key_id <> NEW.app_key_id OR challenge.user_id <> NEW.user_id
      OR challenge.organisation_id <> NEW.org_id OR challenge.team_id <> NEW.team_id
      OR challenge.number <> NEW."to" OR challenge.token_version <> NEW.actor_token_version
      OR challenge.expires_at <> NEW.actor_expires_at OR challenge.used_at IS NOT NULL
      OR challenge.expires_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'Telephone SMS challenge authority is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
