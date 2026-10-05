BEGIN;

-- CreateTable
CREATE TABLE "billing_stripe_payment_invoice_cash_payments" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "stripe_invoice_payment_id" VARCHAR(255) NOT NULL,
    "stripe_payment_intent_id" VARCHAR(255) NOT NULL,
    "stripe_charge_id" VARCHAR(255) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "evidence_digest" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_stripe_payment_invoice_cash_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_stripe_payment_invoice_cash_payments_invoice_id_pai_idx" ON "billing_stripe_payment_invoice_cash_payments"("invoice_id", "paid_at", "id");

-- CreateIndex
CREATE INDEX "billing_stripe_payment_invoice_cash_payments_paid_at_invoic_idx" ON "billing_stripe_payment_invoice_cash_payments"("paid_at", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_cash_invoice_payment_key" ON "billing_stripe_payment_invoice_cash_payments"("account_id", "livemode", "stripe_invoice_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_cash_intent_key" ON "billing_stripe_payment_invoice_cash_payments"("account_id", "livemode", "stripe_payment_intent_id");

-- AddForeignKey
ALTER TABLE "billing_stripe_payment_invoice_cash_payments" ADD CONSTRAINT "billing_stripe_payment_invoice_cash_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_stripe_payment_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve each already verified cash payment's original provider timestamp.
INSERT INTO billing_stripe_payment_invoice_cash_payments
  (id, invoice_id, account_id, livemode, stripe_invoice_payment_id, stripe_payment_intent_id,
   stripe_charge_id, amount_minor, currency, paid_at, evidence_digest)
SELECT 'spc_' || md5(source.id || ':' || (payment->>'invoice_payment_id')),
  source.id, source.account_id, source.livemode, payment->>'invoice_payment_id',
  payment->>'payment_intent_id', payment->>'charge_id', (payment->>'amount_minor')::bigint,
  source.currency, (payment->>'paid_at')::timestamptz AT TIME ZONE 'UTC',
  encode(sha256(convert_to(
    octet_length(payment->>'invoice_payment_id')::text || ':' || (payment->>'invoice_payment_id') ||
    octet_length(payment->>'payment_intent_id')::text || ':' || (payment->>'payment_intent_id') ||
    octet_length(payment->>'charge_id')::text || ':' || (payment->>'charge_id') ||
    octet_length(payment->>'amount_minor')::text || ':' || (payment->>'amount_minor') ||
    octet_length(payment->>'paid_at')::text || ':' || (payment->>'paid_at'), 'UTF8')), 'hex')
FROM billing_stripe_payment_invoices source,
  LATERAL jsonb_array_elements(source.payment_evidence) payment;

-- The original header freezes the first accepted payment set. Further cash
-- appends beneath the same fixed invoice liability and legal document.
ALTER TABLE billing_stripe_payment_invoices DROP CONSTRAINT stripe_paid_invoice_amounts_valid;
ALTER TABLE billing_stripe_payment_invoices ADD CONSTRAINT stripe_paid_invoice_amounts_valid CHECK (
  currency ~ '^[A-Z]{3}$' AND gross_amount_minor >= 0 AND tax_amount_minor >= 0
  AND tax_amount_minor <= gross_amount_minor AND credit_amount_minor >= 0
  AND gross_amount_minor - credit_amount_minor = due_amount_minor
  AND due_amount_minor > 0 AND paid_amount_minor > 0 AND paid_amount_minor <= due_amount_minor
  AND source_digest ~ '^[a-f0-9]{64}$' AND jsonb_typeof(payment_evidence) = 'array'
  AND jsonb_array_length(payment_evidence) > 0 AND cardinality(stripe_payment_intent_ids) > 0
  AND state IN ('PENDING', 'HELD', 'ISSUED') AND
  (state <> 'ISSUED' OR (invoice_number IS NOT NULL AND issued_at IS NOT NULL
    AND issuer_snapshot IS NOT NULL AND buyer_snapshot IS NOT NULL
    AND pdf_object_key IS NOT NULL AND pdf_sha256 ~ '^[a-f0-9]{64}$'))
);
ALTER TABLE billing_stripe_payment_invoice_cash_payments ADD CONSTRAINT stripe_invoice_cash_payment_valid CHECK (
  amount_minor > 0 AND currency ~ '^[A-Z]{3}$' AND evidence_digest ~ '^[a-f0-9]{64}$'
);
CREATE FUNCTION billing_stripe_invoice_cash_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE source record; prior record; current_paid bigint; duplicate boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Stripe invoice cash evidence is immutable' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT * FROM %I.billing_stripe_payment_invoices WHERE id = $1 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO source USING NEW.invoice_id;
  IF source.id IS NULL OR source.account_id <> NEW.account_id OR source.livemode <> NEW.livemode
    OR source.currency <> NEW.currency THEN
    RAISE EXCEPTION 'Stripe invoice cash scope mismatch' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT * FROM %I.billing_stripe_payment_invoice_cash_payments
    WHERE account_id = $1 AND livemode = $2 AND stripe_invoice_payment_id = $3', TG_TABLE_SCHEMA)
    INTO prior USING NEW.account_id, NEW.livemode, NEW.stripe_invoice_payment_id;
  IF prior.id IS NOT NULL THEN
    IF ROW(prior.invoice_id, prior.stripe_payment_intent_id, prior.stripe_charge_id,
      prior.amount_minor, prior.currency, prior.paid_at, prior.evidence_digest) IS DISTINCT FROM
      ROW(NEW.invoice_id, NEW.stripe_payment_intent_id, NEW.stripe_charge_id,
      NEW.amount_minor, NEW.currency, NEW.paid_at, NEW.evidence_digest) THEN
      RAISE EXCEPTION 'Stripe invoice cash evidence mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW.account_id)::text || ':' ||
    NEW.account_id || ':' || NEW.stripe_payment_intent_id, 0));
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.billing_credit_payment_invoices
    WHERE account_id = $1 AND livemode = $2 AND stripe_payment_intent_id = $3)
    OR EXISTS(SELECT 1 FROM %I.billing_stripe_payment_invoices WHERE account_id = $1
      AND livemode = $2 AND id <> $4 AND $3 = ANY(stripe_payment_intent_ids))',
      TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
    INTO duplicate USING NEW.account_id, NEW.livemode, NEW.stripe_payment_intent_id, NEW.invoice_id;
  IF duplicate THEN
    RAISE EXCEPTION 'Stripe cash payment already has another invoice source' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT coalesce(sum(amount_minor), 0) FROM %I.billing_stripe_payment_invoice_cash_payments
    WHERE invoice_id = $1', TG_TABLE_SCHEMA) INTO current_paid USING NEW.invoice_id;
  IF current_paid + NEW.amount_minor > source.due_amount_minor THEN
    RAISE EXCEPTION 'Stripe invoice cash exceeds its legal liability' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_invoice_cash_payment_guard BEFORE INSERT OR UPDATE OR DELETE
  ON billing_stripe_payment_invoice_cash_payments FOR EACH ROW EXECUTE FUNCTION billing_stripe_invoice_cash_payment_guard();
ALTER TABLE billing_stripe_payment_invoice_cash_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_stripe_payment_invoice_cash_payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_stripe_payment_invoice_cash_payments FROM uoa_app;
CREATE POLICY stripe_invoice_cash_payment_deny_app ON billing_stripe_payment_invoice_cash_payments
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
GRANT SELECT, INSERT ON billing_stripe_payment_invoice_cash_payments TO uoa_admin;
COMMIT;
