ALTER TABLE billing_tariff_term_events ADD COLUMN prospective_from TIMESTAMP(3);
ALTER TABLE billing_tariff_term_events ADD CONSTRAINT billing_prospective_terms_month_check CHECK
  (prospective_from IS NULL OR (source='ORGANISATION' AND tariff_id IS NOT NULL
    AND effective_from_month=to_char(prospective_from,'YYYY-MM')));
CREATE TABLE billing_seat_offers (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  tariff_id TEXT NOT NULL UNIQUE REFERENCES billing_tariffs(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  published_by_email VARCHAR(200) NOT NULL, published_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at TIMESTAMP(3)
);
CREATE INDEX billing_seat_offers_service_id_withdrawn_at_idx ON billing_seat_offers(service_id,withdrawn_at);
ALTER TABLE billing_seat_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_seat_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_seat_offers_deny_app ON billing_seat_offers FOR ALL TO uoa_app USING(false) WITH CHECK(false);
ALTER TABLE billing_stripe_checkout_sessions
  ADD COLUMN seat_offer_id TEXT REFERENCES billing_seat_offers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN seat_consent_terms JSONB,
  ADD COLUMN usage_terms_effective_at TIMESTAMP(3),
  ADD COLUMN usage_term_event_id TEXT UNIQUE REFERENCES billing_tariff_term_events(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION guard_billing_seat_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tariff RECORD;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'seat offer evidence cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.service_id,NEW.tariff_id,NEW.published_by_email,NEW.published_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.service_id,OLD.tariff_id,OLD.published_by_email,OLD.published_at)
      OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL THEN
      RAISE EXCEPTION 'seat offer evidence is immutable except first withdrawal';
    END IF;
  ELSE
    SELECT * INTO tariff FROM billing_tariffs WHERE id=NEW.tariff_id AND service_id=NEW.service_id;
    IF NOT FOUND OR tariff.mode<>'STANDARD' OR tariff.collection_mode<>'STRIPE'
      OR tariff.monthly_charge_basis<>'PER_SEAT' OR tariff.seat_policy<>'AUTOMATIC'
      OR tariff.seat_charge_timing<>'PRORATED' OR tariff.usage_payment_mode<>'PREPAID'
      OR tariff.usage_currency<>'USD' OR tariff.markup_bps<>3000
      OR NOT ((tariff.currency IN ('EUR','GBP') AND tariff.monthly_amount_minor=299)
        OR (tariff.currency='USD' AND tariff.monthly_amount_minor=399)) THEN
      RAISE EXCEPTION 'only compatible immutable Standard company seat tariffs may be published';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_seat_offers_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_seat_offers
  FOR EACH ROW EXECUTE FUNCTION guard_billing_seat_offer();
CREATE FUNCTION guard_billing_seat_checkout_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer RECORD;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.seat_offer_id IS DISTINCT FROM OLD.seat_offer_id
    OR NEW.seat_consent_terms IS DISTINCT FROM OLD.seat_consent_terms
    OR (OLD.usage_term_event_id IS NOT NULL AND (NEW.usage_term_event_id IS DISTINCT FROM OLD.usage_term_event_id
      OR NEW.usage_terms_effective_at IS DISTINCT FROM OLD.usage_terms_effective_at))) THEN
    RAISE EXCEPTION 'accepted seat offer and usage activation evidence are immutable';
  END IF;
  IF NEW.seat_offer_id IS NULL THEN
    IF NEW.seat_consent_terms IS NOT NULL OR NEW.usage_term_event_id IS NOT NULL OR NEW.usage_terms_effective_at IS NOT NULL THEN
      RAISE EXCEPTION 'seat acceptance evidence requires a public seat offer';
    END IF;
  ELSE
    SELECT * INTO offer FROM billing_seat_offers WHERE id=NEW.seat_offer_id;
    IF offer.service_id<>NEW.service_id OR offer.tariff_id<>NEW.tariff_id OR NEW.scope<>'ORGANISATION'
      OR NEW.team_id IS NOT NULL OR NEW.tariff_source<>'ORGANISATION' OR NEW.seat_consent_terms IS NULL
      OR NEW.seat_consent_terms->>'terms_version'<>'company-standard-seat-v1'
      OR NEW.seat_consent_terms->>'accepted'<>'true' THEN
      RAISE EXCEPTION 'seat checkout must bind exact published company terms and explicit acceptance';
    END IF;
  END IF;
  IF (NEW.usage_terms_effective_at IS NULL) <> (NEW.usage_term_event_id IS NULL) THEN
    RAISE EXCEPTION 'usage activation time requires its immutable term event';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_seat_checkout_acceptance_guard BEFORE INSERT OR UPDATE ON billing_stripe_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_seat_checkout_acceptance();
