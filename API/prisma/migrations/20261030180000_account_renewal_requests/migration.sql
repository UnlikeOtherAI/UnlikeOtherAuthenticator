CREATE TYPE "AccountRenewalStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

CREATE TABLE "account_renewal_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "AccountRenewalStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_user_id" TEXT,
    "approved_until" TIMESTAMP(3),
    CONSTRAINT "account_renewal_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_renewal_requests_user_id_key" ON "account_renewal_requests"("user_id");
CREATE INDEX "account_renewal_requests_status_requested_at_idx" ON "account_renewal_requests"("status", "requested_at");
ALTER TABLE "account_renewal_requests" ADD CONSTRAINT "account_renewal_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
