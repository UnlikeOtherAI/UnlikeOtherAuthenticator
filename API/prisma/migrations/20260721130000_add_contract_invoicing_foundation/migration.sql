CREATE TYPE "BillingOrganisationContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'TERMINATED');
CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'ISSUING', 'ISSUED', 'VOID');
CREATE TYPE "BillingInvoicePaymentEventKind" AS ENUM ('PAYMENT', 'REFUND', 'WRITE_OFF');
CREATE TYPE "BillingInvoicePaymentEventSource" AS ENUM ('MANUAL', 'STRIPE');
CREATE TABLE "billing_organisation_contracts" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "reference" VARCHAR(100) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "status" "BillingOrganisationContractStatus" NOT NULL DEFAULT 'DRAFT',
  "activated_at" TIMESTAMP(3),
  "terminated_at" TIMESTAMP(3),
  "created_by_user_id" TEXT,
  "created_by_email" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_organisation_contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_organisation_contracts_reference_check" CHECK (btrim("reference") <> ''),
  CONSTRAINT "billing_organisation_contracts_status_check" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "terminated_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "terminated_at" IS NULL)
    OR ("status" = 'TERMINATED' AND "activated_at" IS NOT NULL
      AND "terminated_at" IS NOT NULL AND "terminated_at" >= "activated_at")
  )
);
CREATE TABLE "billing_organisation_contract_versions" (
  "id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "usage_markup_bps" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "payment_terms_days" INTEGER NOT NULL,
  "effective_from_month" CHAR(7) NOT NULL,
  "created_by_user_id" TEXT,
  "created_by_email" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_organisation_contract_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_contract_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "billing_contract_versions_markup_check" CHECK ("usage_markup_bps" BETWEEN 0 AND 100000),
  CONSTRAINT "billing_contract_versions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "billing_contract_versions_payment_terms_check" CHECK ("payment_terms_days" BETWEEN 0 AND 365),
  CONSTRAINT "billing_contract_versions_month_check" CHECK ("effective_from_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
CREATE TABLE "billing_contract_service_terms" (
  "id" TEXT NOT NULL,
  "contract_version_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "tariff_id" TEXT NOT NULL,
  "tariff_assignment_id" TEXT,
  "monthly_amount_minor" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_contract_service_terms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_contract_service_terms_amount_check" CHECK ("monthly_amount_minor" >= 0)
);
CREATE TABLE "billing_invoice_issuer_profiles" (
  "id" TEXT NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "legal_name" VARCHAR(200) NOT NULL,
  "trading_name" VARCHAR(200),
  "billing_email" CITEXT NOT NULL,
  "address" JSONB NOT NULL,
  "tax_identifier" VARCHAR(100),
  "company_registration_number" VARCHAR(100),
  "invoice_number_prefix" VARCHAR(32) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deactivated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_invoice_issuer_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoice_issuer_profiles_prefix_check"
    CHECK ("invoice_number_prefix" ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  CONSTRAINT "billing_invoice_issuer_profiles_active_check" CHECK (
    ("active" = true AND "deactivated_at" IS NULL)
    OR ("active" = false AND "deactivated_at" IS NOT NULL)
  )
);
CREATE TABLE "billing_organisation_invoice_profiles" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "legal_name" VARCHAR(200) NOT NULL,
  "billing_email" CITEXT NOT NULL,
  "billing_address" JSONB NOT NULL,
  "tax_identifier" VARCHAR(100),
  "purchase_order_reference" VARCHAR(120),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_organisation_invoice_profiles_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "billing_invoices" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "contract_version_id" TEXT NOT NULL,
  "issuer_profile_id" TEXT NOT NULL,
  "buyer_profile_id" TEXT NOT NULL,
  "billing_month" CHAR(7) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "invoice_number" VARCHAR(80),
  "issue_date" TIMESTAMP(3),
  "due_date" TIMESTAMP(3),
  "currency" CHAR(3) NOT NULL,
  "subtotal_minor" BIGINT NOT NULL,
  "tax_amount_minor" BIGINT NOT NULL DEFAULT 0,
  "total_minor" BIGINT NOT NULL,
  "credits_applied_minor" BIGINT NOT NULL DEFAULT 0,
  "issuer_snapshot" JSONB NOT NULL,
  "buyer_snapshot" JSONB NOT NULL,
  "calculation_digest" CHAR(64) NOT NULL,
  "pdf_object_key" VARCHAR(1024),
  "pdf_sha256" CHAR(64),
  "pdf_template_version" VARCHAR(80),
  "issued_at" TIMESTAMP(3),
  "voided_at" TIMESTAMP(3),
  "void_reason" VARCHAR(500),
  "created_by_user_id" TEXT,
  "created_by_email" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoices_month_check" CHECK ("billing_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "billing_invoices_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "billing_invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "billing_invoices_amount_check" CHECK (
    "subtotal_minor" >= 0 AND "tax_amount_minor" >= 0
    AND "total_minor" = "subtotal_minor" + "tax_amount_minor"
    AND "credits_applied_minor" >= 0 AND "credits_applied_minor" <= "total_minor"
  ),
  CONSTRAINT "billing_invoices_digest_check" CHECK ("calculation_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "billing_invoices_pdf_check" CHECK (
    ("pdf_object_key" IS NULL AND "pdf_sha256" IS NULL AND "pdf_template_version" IS NULL)
    OR ("pdf_object_key" IS NOT NULL AND "pdf_sha256" ~ '^[a-f0-9]{64}$' AND "pdf_template_version" IS NOT NULL)
  ),
  CONSTRAINT "billing_invoices_status_check" CHECK (
    ("status" = 'DRAFT' AND "invoice_number" IS NULL AND "issue_date" IS NULL
      AND "due_date" IS NULL AND "issued_at" IS NULL AND "voided_at" IS NULL
      AND "void_reason" IS NULL AND "pdf_object_key" IS NULL)
    OR ("status" = 'ISSUING' AND "invoice_number" IS NOT NULL AND "issue_date" IS NOT NULL
      AND "due_date" >= "issue_date" AND "issued_at" IS NULL
      AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status" = 'ISSUED' AND "invoice_number" IS NOT NULL AND "issue_date" IS NOT NULL
      AND "due_date" >= "issue_date" AND "issued_at" IS NOT NULL
      AND "voided_at" IS NULL AND "void_reason" IS NULL AND "pdf_object_key" IS NOT NULL)
    OR ("status" = 'VOID' AND "invoice_number" IS NOT NULL AND "issue_date" IS NOT NULL
      AND "due_date" >= "issue_date" AND "voided_at" IS NOT NULL AND btrim("void_reason") <> '')
  )
);
CREATE TABLE "billing_invoice_lines" (
  "id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "service_identifier" VARCHAR(100) NOT NULL,
  "service_name" VARCHAR(120) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_invoice_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoice_lines_amount_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "billing_invoice_lines_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "billing_invoice_lines_position_check" CHECK ("position" >= 0)
);
CREATE TABLE "billing_invoice_metering_references" (
  "id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "ledger_snapshot_cursor" TEXT NOT NULL,
  "ledger_snapshot_sha256" CHAR(64) NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_invoice_metering_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoice_metering_references_sha_check"
    CHECK ("ledger_snapshot_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "billing_invoice_number_sequences" (
  "id" TEXT NOT NULL,
  "issuer_profile_id" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "last_value" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_invoice_number_sequences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoice_number_sequences_year_check" CHECK ("year" BETWEEN 2000 AND 9999),
  CONSTRAINT "billing_invoice_number_sequences_value_check" CHECK ("last_value" >= 0)
);
CREATE TABLE "billing_invoice_payment_events" (
  "id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "kind" "BillingInvoicePaymentEventKind" NOT NULL,
  "source" "BillingInvoicePaymentEventSource" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "reference" VARCHAR(255),
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_by_user_id" TEXT,
  "created_by_email" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_invoice_payment_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoice_payment_events_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "billing_invoice_payment_events_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "billing_invoice_payment_events_idempotency_check" CHECK (btrim("idempotency_key") <> '')
);
CREATE UNIQUE INDEX "billing_organisation_contracts_org_id_reference_key" ON "billing_organisation_contracts"("org_id", "reference");
CREATE INDEX "billing_organisation_contracts_org_id_status_idx" ON "billing_organisation_contracts"("org_id", "status");
CREATE UNIQUE INDEX "billing_organisation_contracts_one_active_org" ON "billing_organisation_contracts"("org_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "billing_organisation_contract_versions_contract_id_version_key" ON "billing_organisation_contract_versions"("contract_id", "version");
CREATE UNIQUE INDEX "billing_organisation_contract_versions_contract_id_effectiv_key" ON "billing_organisation_contract_versions"("contract_id", "effective_from_month");
CREATE INDEX "billing_organisation_contract_versions_contract_id_effectiv_idx" ON "billing_organisation_contract_versions"("contract_id", "effective_from_month");
CREATE UNIQUE INDEX "billing_contract_service_terms_contract_version_id_service__key" ON "billing_contract_service_terms"("contract_version_id", "service_id");
CREATE INDEX "billing_contract_service_terms_service_id_idx" ON "billing_contract_service_terms"("service_id");
CREATE INDEX "billing_contract_service_terms_tariff_id_idx" ON "billing_contract_service_terms"("tariff_id");
CREATE INDEX "billing_contract_service_terms_tariff_assignment_id_idx" ON "billing_contract_service_terms"("tariff_assignment_id");
CREATE UNIQUE INDEX "billing_invoice_issuer_profiles_key_key" ON "billing_invoice_issuer_profiles"("key");
CREATE UNIQUE INDEX "billing_invoice_issuer_profiles_invoice_number_prefix_key" ON "billing_invoice_issuer_profiles"("invoice_number_prefix");
CREATE INDEX "billing_invoice_issuer_profiles_active_idx" ON "billing_invoice_issuer_profiles"("active");
CREATE UNIQUE INDEX "billing_organisation_invoice_profiles_org_id_key" ON "billing_organisation_invoice_profiles"("org_id");
CREATE UNIQUE INDEX "billing_invoices_invoice_number_key" ON "billing_invoices"("invoice_number");
CREATE UNIQUE INDEX "billing_invoices_contract_id_billing_month_revision_key" ON "billing_invoices"("contract_id", "billing_month", "revision");
CREATE UNIQUE INDEX "billing_invoices_one_active_issue" ON "billing_invoices"("org_id", "billing_month", "currency")
  WHERE "status" IN ('ISSUING', 'ISSUED');
CREATE INDEX "billing_invoices_org_id_billing_month_status_idx" ON "billing_invoices"("org_id", "billing_month", "status");
CREATE INDEX "billing_invoices_contract_version_id_idx" ON "billing_invoices"("contract_version_id");
CREATE INDEX "billing_invoices_issuer_profile_id_idx" ON "billing_invoices"("issuer_profile_id");
CREATE INDEX "billing_invoices_buyer_profile_id_idx" ON "billing_invoices"("buyer_profile_id");
CREATE UNIQUE INDEX "billing_invoice_lines_invoice_id_service_id_key" ON "billing_invoice_lines"("invoice_id", "service_id");
CREATE UNIQUE INDEX "billing_invoice_lines_invoice_id_position_key" ON "billing_invoice_lines"("invoice_id", "position");
CREATE INDEX "billing_invoice_lines_service_id_idx" ON "billing_invoice_lines"("service_id");
CREATE UNIQUE INDEX "billing_invoice_metering_references_invoice_id_service_id_key" ON "billing_invoice_metering_references"("invoice_id", "service_id");
CREATE INDEX "billing_invoice_metering_references_service_id_idx" ON "billing_invoice_metering_references"("service_id");
CREATE UNIQUE INDEX "billing_invoice_number_sequences_issuer_profile_id_year_key" ON "billing_invoice_number_sequences"("issuer_profile_id", "year");
CREATE UNIQUE INDEX "billing_invoice_payment_events_invoice_id_idempotency_key_key" ON "billing_invoice_payment_events"("invoice_id", "idempotency_key");
CREATE INDEX "billing_invoice_payment_events_invoice_id_occurred_at_idx"
  ON "billing_invoice_payment_events"("invoice_id", "occurred_at");
ALTER TABLE "billing_organisation_contracts" ADD CONSTRAINT "billing_organisation_contracts_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_organisation_contract_versions" ADD CONSTRAINT "billing_organisation_contract_versions_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "billing_organisation_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_contract_service_terms" ADD CONSTRAINT "billing_contract_service_terms_contract_version_id_fkey"
  FOREIGN KEY ("contract_version_id") REFERENCES "billing_organisation_contract_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_contract_service_terms" ADD CONSTRAINT "billing_contract_service_terms_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_contract_service_terms" ADD CONSTRAINT "billing_contract_service_terms_tariff_id_fkey"
  FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_contract_service_terms" ADD CONSTRAINT "billing_contract_service_terms_tariff_assignment_id_fkey"
  FOREIGN KEY ("tariff_assignment_id") REFERENCES "billing_tariff_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "billing_organisation_invoice_profiles" ADD CONSTRAINT "billing_organisation_invoice_profiles_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "billing_organisation_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_contract_version_id_fkey"
  FOREIGN KEY ("contract_version_id") REFERENCES "billing_organisation_contract_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_issuer_profile_id_fkey"
  FOREIGN KEY ("issuer_profile_id") REFERENCES "billing_invoice_issuer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_buyer_profile_id_fkey"
  FOREIGN KEY ("buyer_profile_id") REFERENCES "billing_organisation_invoice_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoice_metering_references" ADD CONSTRAINT "billing_invoice_metering_references_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoice_metering_references" ADD CONSTRAINT "billing_invoice_metering_references_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoice_number_sequences" ADD CONSTRAINT "billing_invoice_number_sequences_issuer_profile_id_fkey"
  FOREIGN KEY ("issuer_profile_id") REFERENCES "billing_invoice_issuer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoice_payment_events" ADD CONSTRAINT "billing_invoice_payment_events_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION uoa_guard_billing_organisation_contract()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'active commercial contracts cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."org_id" IS DISTINCT FROM OLD."org_id"
    OR NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_by_email" IS DISTINCT FROM OLD."created_by_email"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN RAISE EXCEPTION 'contract identity is immutable'; END IF;
  IF OLD."status" <> 'DRAFT' AND NEW."name" IS DISTINCT FROM OLD."name" THEN
    RAISE EXCEPTION 'activated contract terms are immutable';
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'ACTIVE'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'TERMINATED'))
    OR (OLD."status" = 'TERMINATED' AND NEW."status" <> 'TERMINATED')
  THEN RAISE EXCEPTION 'invalid contract status transition'; END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM "billing_contract_service_terms" term
    JOIN "billing_organisation_contract_versions" version ON version."id" = term."contract_version_id"
    WHERE version."contract_id" = NEW."id"
  ) THEN RAISE EXCEPTION 'contract requires a version with service terms'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_organisation_contracts_guarded BEFORE UPDATE OR DELETE ON "billing_organisation_contracts"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_organisation_contract();
CREATE OR REPLACE FUNCTION uoa_guard_billing_contract_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest_version INTEGER; latest_month CHAR(7);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'contract versions are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-contract:' || NEW."contract_id", 0));
  IF NOT EXISTS (SELECT 1 FROM "billing_organisation_contracts"
    WHERE "id" = NEW."contract_id" AND "status" <> 'TERMINATED')
  THEN RAISE EXCEPTION 'contract version parent is unavailable' USING ERRCODE = '23503'; END IF;
  IF EXISTS (SELECT 1 FROM "billing_invoices"
    WHERE "contract_id" = NEW."contract_id" AND "billing_month" >= NEW."effective_from_month")
  THEN RAISE EXCEPTION 'contract version cannot change an invoiced period'; END IF;
  SELECT "version", "effective_from_month" INTO latest_version, latest_month
  FROM "billing_organisation_contract_versions"
  WHERE "contract_id" = NEW."contract_id"
  ORDER BY "version" DESC LIMIT 1;
  IF NEW."version" <> COALESCE(latest_version, 0) + 1 THEN
    RAISE EXCEPTION 'contract version must be contiguous';
  END IF;
  IF latest_month IS NOT NULL AND NEW."effective_from_month" <= latest_month THEN
    RAISE EXCEPTION 'contract version month must move forward';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_organisation_contract_versions_immutable BEFORE INSERT OR UPDATE OR DELETE ON "billing_organisation_contract_versions"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_contract_version();
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
  IF EXISTS (SELECT 1 FROM "billing_invoices" WHERE "contract_version_id" = NEW."contract_version_id") THEN
    RAISE EXCEPTION 'contract version is already pinned by an invoice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "billing_tariffs" WHERE "id" = NEW."tariff_id"
    AND "service_id" = NEW."service_id" AND "mode" = 'CUSTOM' AND "collection_mode" = 'MANUAL'
    AND "markup_bps" = version_markup AND "monthly_amount_minor" = NEW."monthly_amount_minor"
    AND "currency" = version_currency)
  THEN RAISE EXCEPTION 'contract tariff is incoherent' USING ERRCODE = '23503'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "billing_tariff_assignments" WHERE "id" = NEW."tariff_assignment_id"
    AND "service_id" = NEW."service_id" AND "tariff_id" = NEW."tariff_id"
    AND "org_id" = parent_org_id AND "scope" = 'ORGANISATION'
    AND "team_id" IS NULL AND "scope_key" = parent_org_id)
  THEN RAISE EXCEPTION 'contract tariff assignment is incoherent' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_contract_service_terms_immutable BEFORE INSERT OR UPDATE OR DELETE ON "billing_contract_service_terms"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_contract_service_term();
CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contract_status "BillingOrganisationContractStatus"; version_currency CHAR(3); version_month CHAR(7);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-contract:' || CASE WHEN TG_OP = 'DELETE' THEN OLD."contract_id" ELSE NEW."contract_id" END, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-contract-version:' || CASE WHEN TG_OP = 'DELETE' THEN OLD."contract_version_id" ELSE NEW."contract_version_id" END, 0));
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'issued invoices cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  SELECT contract."status", version."currency", version."effective_from_month"
    INTO contract_status, version_currency, version_month
  FROM "billing_organisation_contracts" contract
  JOIN "billing_organisation_contract_versions" version
    ON version."contract_id" = contract."id" AND version."id" = NEW."contract_version_id"
  JOIN "billing_organisation_invoice_profiles" buyer
    ON buyer."id" = NEW."buyer_profile_id" AND buyer."org_id" = NEW."org_id"
  WHERE contract."id" = NEW."contract_id" AND contract."org_id" = NEW."org_id";
  IF NOT FOUND OR NEW."currency" <> version_currency OR NEW."billing_month" < version_month
    OR EXISTS (SELECT 1 FROM "billing_organisation_contract_versions" other
      WHERE other."contract_id" = NEW."contract_id" AND other."effective_from_month" <= NEW."billing_month"
        AND other."effective_from_month" > version_month) THEN
    RAISE EXCEPTION 'invoice contract scope is incoherent' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW."org_id" IS DISTINCT FROM OLD."org_id" OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
      OR NEW."contract_version_id" IS DISTINCT FROM OLD."contract_version_id"
      OR NEW."issuer_profile_id" IS DISTINCT FROM OLD."issuer_profile_id"
      OR NEW."buyer_profile_id" IS DISTINCT FROM OLD."buyer_profile_id"
      OR NEW."billing_month" IS DISTINCT FROM OLD."billing_month" OR NEW."revision" IS DISTINCT FROM OLD."revision"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."subtotal_minor" IS DISTINCT FROM OLD."subtotal_minor" OR NEW."tax_amount_minor" IS DISTINCT FROM OLD."tax_amount_minor"
      OR NEW."total_minor" IS DISTINCT FROM OLD."total_minor"
      OR NEW."credits_applied_minor" IS DISTINCT FROM OLD."credits_applied_minor"
      OR NEW."issuer_snapshot" IS DISTINCT FROM OLD."issuer_snapshot"
      OR NEW."buyer_snapshot" IS DISTINCT FROM OLD."buyer_snapshot" OR NEW."calculation_digest" IS DISTINCT FROM OLD."calculation_digest"
      OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
      OR NEW."created_by_email" IS DISTINCT FROM OLD."created_by_email" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    ) THEN RAISE EXCEPTION 'calculated invoice commercial fields are immutable'; END IF;
    IF OLD."status" = 'ISSUED' AND (
      NEW."pdf_object_key" IS DISTINCT FROM OLD."pdf_object_key"
      OR NEW."pdf_sha256" IS DISTINCT FROM OLD."pdf_sha256"
      OR NEW."pdf_template_version" IS DISTINCT FROM OLD."pdf_template_version"
      OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
    ) THEN RAISE EXCEPTION 'issued invoice artifacts are immutable'; END IF;
    IF (OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'ISSUING'))
      OR (OLD."status" = 'ISSUING' AND NEW."status" NOT IN ('ISSUING', 'ISSUED', 'VOID'))
      OR (OLD."status" = 'ISSUED' AND NEW."status" NOT IN ('ISSUED', 'VOID'))
      OR OLD."status" = 'VOID'
    THEN RAISE EXCEPTION 'invalid invoice status transition'; END IF;
  END IF;
  IF NEW."status" = 'ISSUING' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ISSUING') THEN
    IF contract_status <> 'ACTIVE'
      OR NOT EXISTS (SELECT 1 FROM "billing_invoice_issuer_profiles" WHERE "id" = NEW."issuer_profile_id" AND "active" = true)
      OR NOT EXISTS (SELECT 1 FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id")
      OR EXISTS ((SELECT "service_id" FROM "billing_contract_service_terms" WHERE "contract_version_id" = NEW."contract_version_id")
        EXCEPT (SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id"))
      OR EXISTS ((SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id")
        EXCEPT (SELECT "service_id" FROM "billing_contract_service_terms" WHERE "contract_version_id" = NEW."contract_version_id"))
      OR EXISTS ((SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id")
        EXCEPT (SELECT "service_id" FROM "billing_invoice_metering_references" WHERE "invoice_id" = NEW."id"))
      OR EXISTS ((SELECT "service_id" FROM "billing_invoice_metering_references" WHERE "invoice_id" = NEW."id")
        EXCEPT (SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id"))
      OR (SELECT COALESCE(sum("amount_minor"), 0) FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id") <> NEW."subtotal_minor"
    THEN RAISE EXCEPTION 'invoice is not ready for issuance'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'VOID' AND OLD."status" <> 'VOID'
    AND EXISTS (SELECT 1 FROM "billing_invoice_payment_events" WHERE "invoice_id" = NEW."id")
  THEN RAISE EXCEPTION 'settled invoices cannot be voided'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoices_guarded BEFORE INSERT OR UPDATE OR DELETE ON "billing_invoices"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice();
CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice_child()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_invoice_id TEXT; target_service_id TEXT; invoice_status "BillingInvoiceStatus";
  invoice_currency CHAR(3); invoice_version_id TEXT; current_identifier TEXT; current_name TEXT;
  invoice_created_in_transaction BOOLEAN;
BEGIN
  target_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoice_id" ELSE NEW."invoice_id" END;
  target_service_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."service_id" ELSE NEW."service_id" END;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'calculated invoice evidence is immutable'; END IF;
  SELECT "status", "currency", "contract_version_id", xmin = pg_current_xact_id()::xid
    INTO invoice_status, invoice_currency, invoice_version_id, invoice_created_in_transaction
    FROM "billing_invoices" WHERE "id" = target_invoice_id FOR UPDATE;
  IF NOT FOUND OR invoice_status <> 'DRAFT' OR NOT invoice_created_in_transaction
  THEN RAISE EXCEPTION 'calculated invoice evidence is immutable'; END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "billing_contract_service_terms"
      WHERE "contract_version_id" = invoice_version_id AND "service_id" = target_service_id)
    THEN RAISE EXCEPTION 'invoice service is outside the contract' USING ERRCODE = '23503'; END IF;
    IF TG_TABLE_NAME = 'billing_invoice_lines' THEN
      SELECT "identifier", "name" INTO current_identifier, current_name FROM "billing_services" WHERE "id" = target_service_id;
      IF NEW."currency" <> invoice_currency OR NEW."service_identifier" <> current_identifier OR NEW."service_name" <> current_name
      THEN RAISE EXCEPTION 'invoice line snapshot is incoherent' USING ERRCODE = '23503'; END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER billing_invoice_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON "billing_invoice_lines"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice_child();
CREATE TRIGGER billing_invoice_metering_references_immutable BEFORE INSERT OR UPDATE OR DELETE ON "billing_invoice_metering_references"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice_child();
CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice_payment_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice_status "BillingInvoiceStatus"; invoice_currency CHAR(3); invoice_total BIGINT; invoice_credits BIGINT; invoice_issued_at TIMESTAMP(3); payments BIGINT; refunds BIGINT; write_offs BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'invoice payment events are append-only'; END IF;
  SELECT "status", "currency", "total_minor", "credits_applied_minor", "issued_at"
    INTO invoice_status, invoice_currency, invoice_total, invoice_credits, invoice_issued_at
    FROM "billing_invoices" WHERE "id" = NEW."invoice_id" FOR UPDATE;
  IF NOT FOUND OR invoice_status <> 'ISSUED' OR NEW."currency" <> invoice_currency OR NEW."occurred_at" < invoice_issued_at
  THEN RAISE EXCEPTION 'invoice payment event is incoherent' USING ERRCODE = '23503'; END IF;
  SELECT COALESCE(sum("amount_minor") FILTER (WHERE "kind" = 'PAYMENT'), 0), COALESCE(sum("amount_minor") FILTER (WHERE "kind" = 'REFUND'), 0), COALESCE(sum("amount_minor") FILTER (WHERE "kind" = 'WRITE_OFF'), 0)
    INTO payments, refunds, write_offs FROM "billing_invoice_payment_events" WHERE "invoice_id" = NEW."invoice_id";
  IF NEW."kind" = 'PAYMENT' THEN payments := payments + NEW."amount_minor"; ELSIF NEW."kind" = 'REFUND' THEN refunds := refunds + NEW."amount_minor"; ELSE write_offs := write_offs + NEW."amount_minor"; END IF;
  IF payments < refunds OR invoice_credits + payments - refunds + write_offs > invoice_total
  THEN RAISE EXCEPTION 'invoice settlement exceeds balance'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_payment_events_append_only
BEFORE INSERT OR UPDATE OR DELETE ON "billing_invoice_payment_events"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice_payment_event();
CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice_number_sequence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'invoice number sequences cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."issuer_profile_id" IS DISTINCT FROM OLD."issuer_profile_id"
    OR NEW."year" IS DISTINCT FROM OLD."year" OR NEW."last_value" <> OLD."last_value" + 1
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at")
  THEN RAISE EXCEPTION 'invoice number sequence must advance exactly once'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_number_sequences_monotonic
BEFORE UPDATE OR DELETE ON "billing_invoice_number_sequences"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice_number_sequence();
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'billing_organisation_contracts', 'billing_organisation_contract_versions',
    'billing_contract_service_terms', 'billing_invoice_issuer_profiles',
    'billing_organisation_invoice_profiles', 'billing_invoices', 'billing_invoice_lines',
    'billing_invoice_metering_references', 'billing_invoice_number_sequences',
    'billing_invoice_payment_events'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM uoa_app', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO uoa_admin', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO uoa_app USING (false) WITH CHECK (false)',
      table_name || '_deny_app', table_name);
  END LOOP;
END
$$;
