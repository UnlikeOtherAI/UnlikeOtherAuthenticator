CREATE FUNCTION guard_billing_seat_publication_currency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_currency TEXT;
BEGIN
  IF NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM id FROM billing_services WHERE id=NEW.service_id FOR UPDATE;
  SELECT currency INTO selected_currency FROM billing_tariffs WHERE id=NEW.tariff_id;
  IF EXISTS (SELECT 1 FROM billing_seat_offers offer JOIN billing_tariffs tariff ON tariff.id=offer.tariff_id
    WHERE offer.service_id=NEW.service_id AND offer.id<>NEW.id AND offer.withdrawn_at IS NULL
      AND tariff.currency=selected_currency) THEN
    RAISE EXCEPTION 'withdraw the current regional offer before publishing a replacement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_seat_publication_currency_guard BEFORE INSERT ON billing_seat_offers
  FOR EACH ROW EXECUTE FUNCTION guard_billing_seat_publication_currency();

CREATE FUNCTION guard_billing_seat_usage_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tariff RECORD; term RECORD;
BEGIN
  IF NEW.seat_offer_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO tariff FROM billing_tariffs WHERE id=NEW.tariff_id;
  IF NEW.seat_consent_terms->>'terms_version' IS DISTINCT FROM 'company-standard-seat-v1'
    OR NEW.seat_consent_terms->>'accepted' IS DISTINCT FROM 'true'
    OR NEW.seat_consent_terms->>'unit_amount_minor' IS DISTINCT FROM tariff.monthly_amount_minor::text
    OR NEW.seat_consent_terms->>'currency' IS DISTINCT FROM tariff.currency::text
    OR NEW.seat_consent_terms->>'usage_currency' IS DISTINCT FROM tariff.usage_currency::text
    OR NEW.seat_consent_terms->>'usage_payment_mode' IS DISTINCT FROM 'prepaid'
    OR NEW.seat_consent_terms->>'usage_markup_bps' IS DISTINCT FROM tariff.markup_bps::text THEN
    RAISE EXCEPTION 'accepted seat consent must freeze exact separate seat and usage monetary terms';
  END IF;
  IF NEW.usage_term_event_id IS NOT NULL THEN
    SELECT * INTO term FROM billing_tariff_term_events WHERE id=NEW.usage_term_event_id;
    IF term.service_id IS DISTINCT FROM NEW.service_id OR term.source IS DISTINCT FROM 'ORGANISATION'
      OR term.scope_key IS DISTINCT FROM NEW.org_id OR term.tariff_id IS DISTINCT FROM NEW.tariff_id
      OR COALESCE(term.prospective_from,(term.effective_from_month||'-01T00:00:00')::timestamp)
        IS DISTINCT FROM NEW.usage_terms_effective_at THEN
      RAISE EXCEPTION 'accepted seat usage activation requires its exact immutable company term event';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_seat_usage_binding_guard BEFORE INSERT OR UPDATE ON billing_stripe_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_seat_usage_binding();
