CREATE TABLE "billing_prepaid_rating_buckets" (
  "credit_account_id" TEXT PRIMARY KEY REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT,
  "currency" CHAR(3) NOT NULL,
  "cumulative_rated_quanta" DECIMAL(80,0) NOT NULL DEFAULT 0,
  "debited_microcredits" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_prepaid_rating_bucket_positive" CHECK (
    "cumulative_rated_quanta" >= 0 AND "debited_microcredits" >= 0)
);
