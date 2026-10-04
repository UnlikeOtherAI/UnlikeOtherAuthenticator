CREATE TYPE "BillingCreditInvoiceTaxTreatment" AS ENUM ('INCLUSIVE_RATE', 'NO_TAX_CHARGED');

CREATE TABLE "billing_credit_invoice_tax_policies" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL,
  "issuer_profile_id" TEXT NOT NULL REFERENCES "billing_invoice_issuer_profiles"("id") ON DELETE RESTRICT,
  "jurisdiction_country" CHAR(2) NOT NULL,
  "treatment" "BillingCreditInvoiceTaxTreatment" NOT NULL,
  "rate_bps" INTEGER NOT NULL,
  "legal_basis_reference" VARCHAR(500) NOT NULL,
  "effective_from" TIMESTAMP(3) NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "created_by_email" VARCHAR(320) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_credit_invoice_policy_country" CHECK (jurisdiction_country ~ '^[A-Z]{2}$'),
  CONSTRAINT "billing_credit_invoice_policy_rate" CHECK (
    (treatment = 'NO_TAX_CHARGED' AND rate_bps = 0) OR
    (treatment = 'INCLUSIVE_RATE' AND rate_bps BETWEEN 1 AND 10000)
  ),
  CONSTRAINT "billing_credit_invoice_policy_basis" CHECK (length(btrim(legal_basis_reference)) >= 8),
  CONSTRAINT "billing_credit_invoice_policy_version" CHECK (version >= 1)
);
CREATE UNIQUE INDEX "billing_credit_invoice_tax_policies_account_id_version_key"
  ON "billing_credit_invoice_tax_policies"("account_id", "version");
CREATE UNIQUE INDEX "billing_credit_invoice_tax_policies_account_id_jurisdic_key"
  ON "billing_credit_invoice_tax_policies"("account_id", "jurisdiction_country", "effective_from");
CREATE INDEX "billing_credit_invoice_tax_policies_account_id_jurisdic_idx"
  ON "billing_credit_invoice_tax_policies"("account_id", "jurisdiction_country", "effective_from");

ALTER TABLE "billing_credit_payment_invoices" ADD COLUMN "tax_policy_id" TEXT;
ALTER TABLE "billing_credit_payment_invoices"
  ADD CONSTRAINT "billing_credit_payment_invoices_tax_policy_id_fkey"
  FOREIGN KEY ("tax_policy_id") REFERENCES "billing_credit_invoice_tax_policies"("id") ON DELETE RESTRICT;
ALTER TABLE "billing_credit_payment_invoices"
  ADD CONSTRAINT "billing_credit_payment_invoice_policy_evidence" CHECK (
    ("tax_source" = 'ISSUER_POLICY' AND "tax_policy_id" IS NOT NULL
      AND "tax_evidence_reference" = "tax_policy_id") OR
    ("tax_source" IS DISTINCT FROM 'ISSUER_POLICY' AND "tax_policy_id" IS NULL)
  );

CREATE FUNCTION billing_credit_invoice_tax_policy_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'credit invoice tax policy is append-only';
END;
$$;
REVOKE ALL ON FUNCTION billing_credit_invoice_tax_policy_immutable() FROM PUBLIC;
CREATE TRIGGER billing_credit_invoice_tax_policy_immutable_trigger
BEFORE UPDATE OR DELETE ON "billing_credit_invoice_tax_policies"
FOR EACH ROW EXECUTE FUNCTION billing_credit_invoice_tax_policy_immutable();

-- The 183000 trigger predates this policy provenance column. Keep it frozen
-- with every other issued legal fact, while allowing a pending row to advance.
CREATE OR REPLACE FUNCTION billing_credit_payment_invoice_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit payment invoice source is immutable';
  END IF;
  IF ROW(OLD.account_id, OLD.livemode, OLD.stripe_payment_intent_id,
      OLD.stripe_charge_id, OLD.source, OLD.top_up_checkout_id,
      OLD.auto_top_up_attempt_id, OLD.credit_entry_id, OLD.credit_account_id,
      OLD.service_id, OLD.app_key_id, OLD.org_id, OLD.team_id,
      OLD.attributed_user_id, OLD.stripe_customer_id, OLD.currency,
      OLD.gross_amount_minor, OLD.credits_purchased_microcredits, OLD.paid_at)
     IS DISTINCT FROM ROW(NEW.account_id, NEW.livemode, NEW.stripe_payment_intent_id,
      NEW.stripe_charge_id, NEW.source, NEW.top_up_checkout_id,
      NEW.auto_top_up_attempt_id, NEW.credit_entry_id, NEW.credit_account_id,
      NEW.service_id, NEW.app_key_id, NEW.org_id, NEW.team_id,
      NEW.attributed_user_id, NEW.stripe_customer_id, NEW.currency,
      NEW.gross_amount_minor, NEW.credits_purchased_microcredits, NEW.paid_at) THEN
    RAISE EXCEPTION 'credit payment invoice source is immutable';
  END IF;
  IF OLD.state = 'ISSUED' AND ROW(OLD.state, OLD.stripe_invoice_id,
      OLD.tax_amount_minor, OLD.tax_source, OLD.tax_evidence_reference, OLD.tax_policy_id,
      OLD.issuer_profile_id, OLD.buyer_profile_id, OLD.issuer_snapshot,
      OLD.buyer_snapshot, OLD.invoice_number, OLD.issued_at,
      OLD.pdf_object_key, OLD.pdf_sha256)
    IS DISTINCT FROM ROW(NEW.state, NEW.stripe_invoice_id,
      NEW.tax_amount_minor, NEW.tax_source, NEW.tax_evidence_reference, NEW.tax_policy_id,
      NEW.issuer_profile_id, NEW.buyer_profile_id, NEW.issuer_snapshot,
      NEW.buyer_snapshot, NEW.invoice_number, NEW.issued_at,
      NEW.pdf_object_key, NEW.pdf_sha256) THEN
    RAISE EXCEPTION 'issued credit payment invoice is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_credit_payment_invoice_delete_forbidden
BEFORE DELETE ON "billing_credit_payment_invoices"
FOR EACH ROW EXECUTE FUNCTION billing_credit_payment_invoice_immutable();
