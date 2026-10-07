BEGIN;

-- CreateTable
CREATE TABLE "billing_stripe_payment_invoice_adjustments" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "stripe_payment_intent_id" VARCHAR(255) NOT NULL,
    "stripe_charge_id" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "stripe_object_id" VARCHAR(255) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "evidence_digest" CHAR(64) NOT NULL,
    "stripe_event_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_stripe_payment_invoice_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_stripe_payment_invoice_adjustments_invoice_id_occur_idx" ON "billing_stripe_payment_invoice_adjustments"("invoice_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_stripe_payment_invoice_adjustments_invoice_id_kind__key" ON "billing_stripe_payment_invoice_adjustments"("invoice_id", "kind", "stripe_object_id");

-- AddForeignKey
ALTER TABLE "billing_stripe_payment_invoice_adjustments" ADD CONSTRAINT "billing_stripe_payment_invoice_adjustments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_stripe_payment_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE billing_stripe_payment_invoice_adjustments ADD CONSTRAINT stripe_invoice_cash_adjustment_valid CHECK (
  kind IN ('REFUND', 'DISPUTE', 'DISPUTE_REVERSAL') AND amount_minor > 0
  AND currency ~ '^[A-Z]{3}$' AND evidence_digest ~ '^[a-f0-9]{64}$'
);
CREATE FUNCTION billing_stripe_cash_adjustment_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Stripe invoice cash evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER stripe_cash_adjustment_immutable BEFORE UPDATE OR DELETE
  ON billing_stripe_payment_invoice_adjustments FOR EACH ROW EXECUTE FUNCTION billing_stripe_cash_adjustment_immutable();
ALTER TABLE billing_stripe_payment_invoice_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_stripe_payment_invoice_adjustments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_stripe_payment_invoice_adjustments FROM uoa_app;
CREATE POLICY stripe_cash_adjustment_deny_app ON billing_stripe_payment_invoice_adjustments
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
GRANT SELECT, INSERT ON billing_stripe_payment_invoice_adjustments TO uoa_admin;
COMMIT;
