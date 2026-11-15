BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Publish prospective versions; never rewrite a tariff that valued historical usage.
DO $$
DECLARE target_service text; prior billing_tariffs%ROWTYPE; chosen_id text; billing_currency text;
BEGIN
  SELECT id INTO target_service FROM billing_services WHERE identifier='nessie' AND active FOR UPDATE;
  IF target_service IS NULL THEN RETURN; END IF;
  FOREACH billing_currency IN ARRAY ARRAY['USD','EUR','GBP'] LOOP
    SELECT * INTO prior FROM billing_tariffs t WHERE t.service_id=target_service
      AND t.key='standard-'||lower(billing_currency) ORDER BY version DESC LIMIT 1;
    IF NOT FOUND OR prior.mode<>'STANDARD' OR prior.collection_mode<>'STRIPE'
      OR prior.monthly_charge_basis<>'PER_SEAT' OR prior.monthly_amount_minor<=0
      OR prior.seat_policy IS DISTINCT FROM 'AUTOMATIC' OR prior.seat_charge_timing IS DISTINCT FROM 'PRORATED'
      OR prior.usage_payment_mode<>'PREPAID' THEN
      RAISE EXCEPTION 'Publish the approved regular regional seat catalog before the Nessie billing cutover';
    END IF;
    IF NOT prior.anniversary_seats OR prior.usage_currency<>'USD' THEN
      INSERT INTO billing_tariffs(id,service_id,key,version,name,mode,collection_mode,markup_bps,
        monthly_amount_minor,monthly_charge_basis,seat_policy,seat_charge_timing,anniversary_seats,
        usage_payment_mode,usage_currency,currency,is_default,created_by_email)
      VALUES(gen_random_uuid()::text,target_service,prior.key,prior.version+1,prior.name,prior.mode,
        prior.collection_mode,prior.markup_bps,prior.monthly_amount_minor,prior.monthly_charge_basis,
        prior.seat_policy,prior.seat_charge_timing,true,prior.usage_payment_mode,'USD',prior.currency,false,
        'system:nessie-payment-admission') RETURNING id INTO chosen_id;
    ELSE chosen_id:=prior.id;
    END IF;
    IF billing_currency='USD' THEN
      UPDATE billing_tariffs t SET is_default=false WHERE t.service_id=target_service AND is_default;
      UPDATE billing_tariffs SET is_default=true WHERE id=chosen_id;
      -- Old statements retain their old monthly terms. New admissions use the published default now.
      INSERT INTO billing_tariff_term_events(id,service_id,source,scope_key,effective_from_month,tariff_id,reason,actor_email)
      VALUES(gen_random_uuid()::text,target_service,'SERVICE_DEFAULT',target_service,
        to_char((clock_timestamp() AT TIME ZONE 'UTC')+interval '1 month','YYYY-MM'),chosen_id,
        'nessie-regular-default','system:nessie-payment-admission');
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION billing_guard_nessie_regular_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_default AND EXISTS(SELECT 1 FROM billing_services WHERE id=NEW.service_id AND identifier='nessie')
    AND (NEW.mode<>'STANDARD' OR NEW.collection_mode<>'STRIPE' OR NEW.monthly_charge_basis<>'PER_SEAT'
      OR NEW.monthly_amount_minor<=0 OR NEW.usage_payment_mode<>'PREPAID') THEN
    RAISE EXCEPTION 'Nessie requires a regular prepaid default' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_nessie_regular_default BEFORE INSERT OR UPDATE ON billing_tariffs
  FOR EACH ROW EXECUTE FUNCTION billing_guard_nessie_regular_default();
COMMIT;
