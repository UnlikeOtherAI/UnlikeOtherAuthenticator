-- New manual versions are staged for a future month. A null assignment means
-- the immutable service term supplies the price when that month arrives.
CREATE OR REPLACE FUNCTION uoa_guard_billing_contract_service_term()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_org_id TEXT; version_markup INTEGER; version_currency CHAR(3); parent_status "BillingOrganisationContractStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."tariff_assignment_id" IS NULL AND OLD."tariff_assignment_id" IS NOT NULL AND to_jsonb(NEW) - 'tariff_assignment_id' = to_jsonb(OLD) - 'tariff_assignment_id' THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'contract service terms are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-contract-version:' || NEW."contract_version_id", 0));
  SELECT contract."org_id", version."usage_markup_bps", version."currency", contract."status"
    INTO parent_org_id, version_markup, version_currency, parent_status
  FROM "billing_organisation_contract_versions" version
  JOIN "billing_organisation_contracts" contract ON contract."id" = version."contract_id"
  WHERE version."id" = NEW."contract_version_id";
  IF NOT FOUND OR parent_status = 'TERMINATED' THEN
    RAISE EXCEPTION 'contract service term parent is unavailable' USING ERRCODE = '23503';
  END IF;
  PERFORM uoa_lock_stripe_contract_scope(NEW."service_id", parent_org_id);
  IF uoa_stripe_scope_blocks_manual_contract(NEW."service_id", parent_org_id) THEN
    RAISE EXCEPTION 'Stripe checkout or subscription blocks manual contract activation'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "billing_invoices" WHERE "contract_version_id" = NEW."contract_version_id") THEN
    RAISE EXCEPTION 'contract version is already pinned by an invoice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "billing_tariffs" WHERE "id" = NEW."tariff_id"
    AND "service_id" = NEW."service_id" AND "mode" = 'CUSTOM' AND "collection_mode" = 'MANUAL'
    AND "markup_bps" = version_markup AND "monthly_amount_minor" = NEW."monthly_amount_minor"
    AND "currency" = version_currency)
  THEN RAISE EXCEPTION 'contract tariff is incoherent' USING ERRCODE = '23503'; END IF;
  IF NEW."tariff_assignment_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "billing_tariff_assignments" WHERE "id" = NEW."tariff_assignment_id"
      AND "service_id" = NEW."service_id" AND "tariff_id" = NEW."tariff_id"
      AND "org_id" = parent_org_id AND "scope" = 'ORGANISATION'
      AND "team_id" IS NULL AND "scope_key" = parent_org_id)
  THEN RAISE EXCEPTION 'contract tariff assignment is incoherent' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;

-- Stripe must see a contract that is live this month or already scheduled for a
-- later month; dropping a service in a future version must not unblock it early.
CREATE OR REPLACE FUNCTION uoa_active_contract_covers_service(candidate_service_id TEXT, candidate_org_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "billing_organisation_contracts" contract
    JOIN "billing_organisation_contract_versions" version ON version."contract_id" = contract."id"
    JOIN "billing_contract_service_terms" term ON term."contract_version_id" = version."id"
    WHERE contract."org_id" = candidate_org_id AND contract."status" = 'ACTIVE'
      AND term."service_id" = candidate_service_id
      AND (
        version."effective_from_month" > to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM')
        OR version."id" = (
          SELECT current_version."id" FROM "billing_organisation_contract_versions" current_version
          WHERE current_version."contract_id" = contract."id"
            AND current_version."effective_from_month" <= to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM')
            AND EXISTS (SELECT 1 FROM "billing_contract_service_terms" current_term
              WHERE current_term."contract_version_id" = current_version."id")
          ORDER BY current_version."effective_from_month" DESC, current_version."version" DESC
          LIMIT 1
        )
      )
  );
$$;
