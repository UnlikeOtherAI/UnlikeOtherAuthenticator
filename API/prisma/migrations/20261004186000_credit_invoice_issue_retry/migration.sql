ALTER TABLE "billing_credit_payment_invoices"
  ADD COLUMN "issue_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_issue_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "last_issue_error" VARCHAR(160);

ALTER TABLE "billing_credit_payment_invoices"
  ADD CONSTRAINT "billing_credit_payment_invoice_attempt_count" CHECK ("issue_attempt_count" >= 0);

CREATE INDEX "billing_credit_payment_invoices_account_id_state_next_issue_attempt_at_id_idx"
  ON "billing_credit_payment_invoices"("account_id", "state", "next_issue_attempt_at", "id");
