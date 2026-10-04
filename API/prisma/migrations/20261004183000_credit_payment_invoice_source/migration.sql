-- CreateEnum
CREATE TYPE "BillingCreditPaymentInvoiceSource" AS ENUM ('MANUAL_TOP_UP', 'AUTO_RECHARGE');

-- CreateEnum
CREATE TYPE "BillingCreditPaymentInvoiceState" AS ENUM ('PENDING', 'HELD', 'ISSUING', 'ISSUED');

-- CreateEnum
CREATE TYPE "BillingCreditPaymentInvoiceTaxSource" AS ENUM ('STRIPE_INVOICE', 'ISSUER_POLICY');

-- CreateTable
CREATE TABLE "billing_credit_payment_invoices" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "stripe_payment_intent_id" VARCHAR(255) NOT NULL,
    "stripe_charge_id" VARCHAR(255) NOT NULL,
    "stripe_invoice_id" VARCHAR(255),
    "source" "BillingCreditPaymentInvoiceSource" NOT NULL,
    "top_up_checkout_id" TEXT,
    "auto_top_up_attempt_id" TEXT,
    "credit_entry_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "attributed_user_id" TEXT NOT NULL,
    "stripe_customer_id" VARCHAR(255) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "credits_purchased_microcredits" BIGINT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "state" "BillingCreditPaymentInvoiceState" NOT NULL DEFAULT 'PENDING',
    "hold_reason" VARCHAR(160),
    "tax_amount_minor" BIGINT,
    "tax_source" "BillingCreditPaymentInvoiceTaxSource",
    "tax_evidence_reference" VARCHAR(255),
    "issuer_profile_id" TEXT,
    "buyer_profile_id" TEXT,
    "issuer_snapshot" JSONB,
    "buyer_snapshot" JSONB,
    "invoice_number" VARCHAR(80),
    "issued_at" TIMESTAMP(3),
    "pdf_object_key" VARCHAR(1024),
    "pdf_sha256" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_payment_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_invoices_top_up_checkout_id_key" ON "billing_credit_payment_invoices"("top_up_checkout_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_invoices_auto_top_up_attempt_id_key" ON "billing_credit_payment_invoices"("auto_top_up_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_invoices_credit_entry_id_key" ON "billing_credit_payment_invoices"("credit_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_invoices_invoice_number_key" ON "billing_credit_payment_invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "billing_credit_payment_invoices_org_id_team_id_paid_at_id_idx" ON "billing_credit_payment_invoices"("org_id", "team_id", "paid_at", "id");

-- CreateIndex
CREATE INDEX "billing_credit_payment_invoices_service_id_paid_at_idx" ON "billing_credit_payment_invoices"("service_id", "paid_at");

-- CreateIndex
CREATE INDEX "billing_credit_payment_invoices_state_paid_at_idx" ON "billing_credit_payment_invoices"("state", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_invoices_account_id_livemode_stripe__key" ON "billing_credit_payment_invoices"("account_id", "livemode", "stripe_payment_intent_id");

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_credit_entry_id_fkey" FOREIGN KEY ("credit_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_top_up_checkout_id_fkey" FOREIGN KEY ("top_up_checkout_id") REFERENCES "billing_credit_top_up_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_auto_top_up_attempt_id_fkey" FOREIGN KEY ("auto_top_up_attempt_id") REFERENCES "billing_credit_auto_top_up_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_issuer_profile_id_fkey" FOREIGN KEY ("issuer_profile_id") REFERENCES "billing_invoice_issuer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_invoices" ADD CONSTRAINT "billing_credit_payment_invoices_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "billing_organisation_invoice_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "billing_credit_payment_invoices"
  ADD CONSTRAINT "billing_credit_payment_invoice_source_exactly_one" CHECK (
    ("source" = 'MANUAL_TOP_UP' AND "top_up_checkout_id" IS NOT NULL AND "auto_top_up_attempt_id" IS NULL)
    OR ("source" = 'AUTO_RECHARGE' AND "auto_top_up_attempt_id" IS NOT NULL AND "top_up_checkout_id" IS NULL)
  ),
  ADD CONSTRAINT "billing_credit_payment_invoice_positive_payment" CHECK (
    "gross_amount_minor" > 0 AND "credits_purchased_microcredits" > 0
  ),
  ADD CONSTRAINT "billing_credit_payment_invoice_tax_evidence" CHECK (
    ("tax_amount_minor" IS NULL AND "tax_source" IS NULL AND "tax_evidence_reference" IS NULL)
    OR ("tax_amount_minor" >= 0 AND "tax_amount_minor" <= "gross_amount_minor"
      AND "tax_source" IS NOT NULL AND "tax_evidence_reference" IS NOT NULL)
  ),
  ADD CONSTRAINT "billing_credit_payment_invoice_issued_complete" CHECK (
    "state" <> 'ISSUED' OR (
      "hold_reason" IS NULL AND "tax_amount_minor" IS NOT NULL
      AND "issuer_profile_id" IS NOT NULL AND "buyer_profile_id" IS NOT NULL
      AND "issuer_snapshot" IS NOT NULL AND "buyer_snapshot" IS NOT NULL
      AND "invoice_number" IS NOT NULL AND "issued_at" IS NOT NULL
      AND "pdf_object_key" IS NOT NULL AND "pdf_sha256" IS NOT NULL
    )
  );

CREATE FUNCTION billing_credit_payment_invoice_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
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
      OLD.tax_amount_minor, OLD.tax_source, OLD.tax_evidence_reference,
      OLD.issuer_profile_id, OLD.buyer_profile_id, OLD.issuer_snapshot,
      OLD.buyer_snapshot, OLD.invoice_number, OLD.issued_at,
      OLD.pdf_object_key, OLD.pdf_sha256)
    IS DISTINCT FROM ROW(NEW.state, NEW.stripe_invoice_id,
      NEW.tax_amount_minor, NEW.tax_source, NEW.tax_evidence_reference,
      NEW.issuer_profile_id, NEW.buyer_profile_id, NEW.issuer_snapshot,
      NEW.buyer_snapshot, NEW.invoice_number, NEW.issued_at,
      NEW.pdf_object_key, NEW.pdf_sha256) THEN
    RAISE EXCEPTION 'issued credit payment invoice is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION billing_credit_payment_invoice_immutable() FROM PUBLIC;
CREATE TRIGGER billing_credit_payment_invoice_immutable_trigger
BEFORE UPDATE ON "billing_credit_payment_invoices"
FOR EACH ROW EXECUTE FUNCTION billing_credit_payment_invoice_immutable();

-- Only fully proven historical successes enter the document queue. Rows with
-- incomplete webhook/credit lineage need explicit operator reconciliation.
INSERT INTO billing_credit_payment_invoices (
  id, account_id, livemode, stripe_payment_intent_id, stripe_charge_id,
  source, top_up_checkout_id, credit_entry_id, credit_account_id,
  service_id, app_key_id, org_id, team_id, attributed_user_id,
  stripe_customer_id, currency, gross_amount_minor,
  credits_purchased_microcredits, paid_at, state, updated_at
)
SELECT 'topup-' || checkout.id, checkout.account_id, account.livemode,
  checkout.stripe_payment_intent_id, webhook.stripe_charge_id,
  'MANUAL_TOP_UP', checkout.id, entry.id, checkout.credit_account_id,
  checkout.service_id, checkout.app_key_id, credit_account.org_id,
  credit_account.team_id, checkout.requested_by_user_id,
  customer.stripe_customer_id, checkout.currency, checkout.payment_amount_minor,
  checkout.credits_received_microcredits, webhook.stripe_created_at,
  'PENDING', CURRENT_TIMESTAMP
FROM billing_credit_top_up_checkouts checkout
JOIN billing_stripe_accounts account ON account.id = checkout.account_id
JOIN billing_credit_accounts credit_account ON credit_account.id = checkout.credit_account_id
JOIN billing_stripe_customers customer ON customer.id = checkout.customer_id
JOIN billing_credit_entries entry ON entry.id = checkout.credit_entry_id
JOIN billing_stripe_webhook_events webhook ON webhook.id = checkout.completion_webhook_event_id
WHERE checkout.status = 'COMPLETE'
  AND checkout.stripe_payment_intent_id IS NOT NULL
  AND webhook.type = 'payment_intent.succeeded'
  AND webhook.account_id = checkout.account_id
  AND webhook.livemode = account.livemode
  AND webhook.stripe_payment_intent_id = checkout.stripe_payment_intent_id
  AND webhook.stripe_charge_id IS NOT NULL
  AND webhook.stripe_customer_id = customer.stripe_customer_id
  AND webhook.amount_minor = checkout.payment_amount_minor
  AND webhook.currency = checkout.currency
  AND entry.credit_account_id = checkout.credit_account_id
  AND entry.kind = 'TOP_UP'
  AND entry.direction = 'CREDIT'
  AND entry.amount_microcredits = checkout.credits_received_microcredits
  AND entry.source_type = 'credit_top_up_checkout'
  AND entry.source_id = checkout.id;

INSERT INTO billing_credit_payment_invoices (
  id, account_id, livemode, stripe_payment_intent_id, stripe_charge_id,
  source, auto_top_up_attempt_id, credit_entry_id, credit_account_id,
  service_id, app_key_id, org_id, team_id, attributed_user_id,
  stripe_customer_id, currency, gross_amount_minor,
  credits_purchased_microcredits, paid_at, state, updated_at
)
SELECT 'autotopup-' || attempt.id, attempt.account_id, account.livemode,
  attempt.stripe_payment_intent_id, webhook.stripe_charge_id,
  'AUTO_RECHARGE', attempt.id, entry.id, attempt.credit_account_id,
  attempt.service_id, attempt.app_key_id, credit_account.org_id,
  credit_account.team_id, attempt.attributed_user_id,
  customer.stripe_customer_id, 'USD', attempt.payment_amount_minor,
  attempt.credits_received_microcredits, webhook.stripe_created_at,
  'PENDING', CURRENT_TIMESTAMP
FROM billing_credit_auto_top_up_attempts attempt
JOIN billing_stripe_accounts account ON account.id = attempt.account_id
JOIN billing_credit_accounts credit_account ON credit_account.id = attempt.credit_account_id
JOIN billing_stripe_customers customer ON customer.id = credit_account.customer_id
JOIN billing_credit_entries entry ON entry.id = attempt.credit_entry_id
JOIN billing_stripe_webhook_events webhook ON webhook.id = attempt.success_webhook_event_id
WHERE attempt.status = 'SUCCEEDED'
  AND attempt.stripe_payment_intent_id IS NOT NULL
  AND webhook.type = 'payment_intent.succeeded'
  AND webhook.account_id = attempt.account_id
  AND webhook.livemode = account.livemode
  AND webhook.stripe_payment_intent_id = attempt.stripe_payment_intent_id
  AND webhook.stripe_charge_id IS NOT NULL
  AND webhook.stripe_customer_id = customer.stripe_customer_id
  AND webhook.amount_minor = attempt.payment_amount_minor
  AND webhook.currency = 'USD'
  AND entry.credit_account_id = attempt.credit_account_id
  AND entry.kind = 'AUTOMATIC_TOP_UP'
  AND entry.direction = 'CREDIT'
  AND entry.amount_microcredits = attempt.credits_received_microcredits
  AND entry.source_type = 'credit_auto_top_up_attempt'
  AND entry.source_id = attempt.id;
