CREATE TABLE "billing_credit_settlement_watches" (
  "id" TEXT NOT NULL,
  "credit_account_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "billing_month" CHAR(7) NOT NULL,
  "next_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_checked_at" TIMESTAMP(3),
  "last_cursor" VARCHAR(80),
  "last_error" VARCHAR(160),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_credit_settlement_watches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_credit_settlement_watches_month_check"
    CHECK ("billing_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "billing_credit_settlement_watches_credit_account_id_fkey"
    FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_credit_settlement_watches_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "billing_credit_watch_payer_team_month_key"
  ON "billing_credit_settlement_watches"("credit_account_id", "team_id", "billing_month");
CREATE INDEX "billing_credit_settlement_watches_next_check_at_billing_month_idx"
  ON "billing_credit_settlement_watches"("next_check_at", "billing_month");
