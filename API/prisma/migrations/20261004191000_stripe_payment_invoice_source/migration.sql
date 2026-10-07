BEGIN;

-- CreateTable
CREATE TABLE "billing_stripe_payment_invoices" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "stripe_invoice_id" VARCHAR(255) NOT NULL,
    "stripe_customer_id" VARCHAR(255) NOT NULL,
    "stripe_payment_intent_ids" TEXT[],
    "payment_evidence" JSONB NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "tax_amount_minor" BIGINT NOT NULL,
    "credit_amount_minor" BIGINT NOT NULL,
    "due_amount_minor" BIGINT NOT NULL,
    "paid_amount_minor" BIGINT NOT NULL,
    "source_digest" CHAR(64) NOT NULL,
    "state" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "hold_reason" VARCHAR(160),
    "issue_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_issue_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoice_number" VARCHAR(80),
    "issued_at" TIMESTAMP(3),
    "issuer_snapshot" JSONB,
    "buyer_snapshot" JSONB,
    "pdf_object_key" VARCHAR(1024),
    "pdf_sha256" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_stripe_payment_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_stripe_payment_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "stripe_line_id" VARCHAR(255) NOT NULL,
    "service_id" TEXT NOT NULL,
    "service_identifier" VARCHAR(100) NOT NULL,
    "billing_month" CHAR(7) NOT NULL,
    "label" VARCHAR(240) NOT NULL,
    "subscription_minor" BIGINT NOT NULL,
    "usage_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "credit_minor" BIGINT NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "due_minor" BIGINT NOT NULL,

    CONSTRAINT "billing_stripe_payment_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_stripe_payment_invoices_org_id_team_id_paid_at_id_idx" ON "billing_stripe_payment_invoices"("org_id", "team_id", "paid_at", "id");

-- CreateIndex
CREATE INDEX "billing_stripe_payment_invoices_state_next_issue_attempt_at_idx" ON "billing_stripe_payment_invoices"("state", "next_issue_attempt_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_stripe_payment_invoices_account_id_livemode_stripe__key" ON "billing_stripe_payment_invoices"("account_id", "livemode", "stripe_invoice_id");

-- CreateIndex
CREATE INDEX "billing_stripe_payment_invoice_lines_service_id_billing_mon_idx" ON "billing_stripe_payment_invoice_lines"("service_id", "billing_month");

-- CreateIndex
CREATE UNIQUE INDEX "billing_stripe_payment_invoice_lines_invoice_id_stripe_line_key" ON "billing_stripe_payment_invoice_lines"("invoice_id", "stripe_line_id");

-- AddForeignKey
ALTER TABLE "billing_stripe_payment_invoices" ADD CONSTRAINT "billing_stripe_payment_invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_stripe_payment_invoices" ADD CONSTRAINT "billing_stripe_payment_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "billing_stripe_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_stripe_payment_invoice_lines" ADD CONSTRAINT "billing_stripe_payment_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_stripe_payment_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_stripe_payment_invoice_lines" ADD CONSTRAINT "billing_stripe_payment_invoice_lines_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE billing_stripe_payment_invoices ADD CONSTRAINT stripe_paid_invoice_amounts_valid CHECK (
  currency ~ '^[A-Z]{3}$' AND gross_amount_minor >= 0 AND tax_amount_minor >= 0
  AND tax_amount_minor <= gross_amount_minor AND credit_amount_minor >= 0
  AND gross_amount_minor - credit_amount_minor = due_amount_minor
  AND due_amount_minor > 0 AND paid_amount_minor = due_amount_minor
  AND source_digest ~ '^[a-f0-9]{64}$' AND jsonb_typeof(payment_evidence) = 'array'
  AND jsonb_array_length(payment_evidence) > 0 AND cardinality(stripe_payment_intent_ids) > 0
  AND state IN ('PENDING', 'HELD', 'ISSUED') AND
  (state <> 'ISSUED' OR (invoice_number IS NOT NULL AND issued_at IS NOT NULL
    AND issuer_snapshot IS NOT NULL AND buyer_snapshot IS NOT NULL
    AND pdf_object_key IS NOT NULL AND pdf_sha256 ~ '^[a-f0-9]{64}$'))
);
ALTER TABLE billing_stripe_payment_invoice_lines ADD CONSTRAINT stripe_paid_invoice_line_valid CHECK (
  billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  AND subscription_minor >= 0 AND usage_minor >= 0 AND tax_minor >= 0
  AND credit_minor >= 0 AND gross_minor >= tax_minor
  AND due_minor = gross_minor - credit_minor AND due_minor >= 0
  AND subscription_minor + usage_minor + tax_minor = gross_minor
);

CREATE FUNCTION billing_stripe_payment_invoice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stripe payment invoice source is immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state','hold_reason','issue_attempt_count','next_issue_attempt_at',
      'invoice_number','issued_at','issuer_snapshot','buyer_snapshot','pdf_object_key','pdf_sha256','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','hold_reason','issue_attempt_count','next_issue_attempt_at',
      'invoice_number','issued_at','issuer_snapshot','buyer_snapshot','pdf_object_key','pdf_sha256','updated_at'])
    OR (OLD.invoice_number IS NOT NULL AND ROW(NEW.invoice_number, NEW.issued_at,
      NEW.issuer_snapshot, NEW.buyer_snapshot, NEW.pdf_object_key, NEW.pdf_sha256)
      IS DISTINCT FROM ROW(OLD.invoice_number, OLD.issued_at, OLD.issuer_snapshot,
        OLD.buyer_snapshot, OLD.pdf_object_key, OLD.pdf_sha256))
    OR (OLD.state = 'ISSUED' AND NEW.state <> 'ISSUED') THEN
    RAISE EXCEPTION 'Stripe payment invoice source is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_payment_invoice_immutable BEFORE UPDATE OR DELETE
  ON billing_stripe_payment_invoices FOR EACH ROW EXECUTE FUNCTION billing_stripe_payment_invoice_guard();
CREATE FUNCTION billing_stripe_payment_invoice_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Stripe payment invoice line is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER stripe_payment_invoice_line_immutable BEFORE UPDATE OR DELETE
  ON billing_stripe_payment_invoice_lines FOR EACH ROW EXECUTE FUNCTION billing_stripe_payment_invoice_line_guard();

ALTER TABLE billing_stripe_payment_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_stripe_payment_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_stripe_payment_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_stripe_payment_invoice_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_stripe_payment_invoices, billing_stripe_payment_invoice_lines FROM uoa_app;
CREATE POLICY stripe_payment_invoice_deny_app ON billing_stripe_payment_invoices
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
CREATE POLICY stripe_payment_invoice_line_deny_app ON billing_stripe_payment_invoice_lines
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE ON billing_stripe_payment_invoices TO uoa_admin;
GRANT SELECT, INSERT ON billing_stripe_payment_invoice_lines TO uoa_admin;
COMMIT;
