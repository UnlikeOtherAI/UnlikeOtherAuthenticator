ALTER TABLE "billing_credit_top_up_offers"
  ADD COLUMN "manual_purchase_enabled" BOOLEAN NOT NULL DEFAULT TRUE;

-- Availability can change without rewriting the price or a saved reload agreement.
CREATE OR REPLACE FUNCTION "billing_guard_versioned_terms"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable_fields text[] := ARRAY['active', 'deactivated_at', 'updated_at'] || TG_ARGV;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is immutable; deactivate it instead', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - mutable_fields) IS DISTINCT FROM (to_jsonb(OLD) - mutable_fields) THEN
    RAISE EXCEPTION '% terms are immutable; create a new version', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "billing_credit_top_up_offers_versioned_terms" ON "billing_credit_top_up_offers";
CREATE TRIGGER "billing_credit_top_up_offers_versioned_terms"
  BEFORE UPDATE OR DELETE ON "billing_credit_top_up_offers"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_versioned_terms"('manual_purchase_enabled');
