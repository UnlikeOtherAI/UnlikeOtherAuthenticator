SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- AlterTable
ALTER TABLE "billing_credit_entries" ADD COLUMN     "sms_inbound_receipt_id" TEXT,
ADD COLUMN     "sms_reservation_id" TEXT;

-- AlterTable
ALTER TABLE "billing_sms_quotes" ADD COLUMN     "provider_bound_amount" DECIMAL(38,18),
ADD COLUMN     "route_policy_id" TEXT;

-- AlterTable
ALTER TABLE "billing_sms_number_resources" ADD COLUMN     "refund_evidence_digest" CHAR(64),
ADD COLUMN     "refunded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "billing_sms_reservations" ADD COLUMN     "delegate_id" VARCHAR(160),
ADD COLUMN     "grant_id" TEXT;

-- AlterTable
ALTER TABLE "billing_sms_standing_holds" ADD COLUMN     "quote_id" TEXT NOT NULL,
ADD COLUMN     "retired_at" TIMESTAMP(3);
ALTER TABLE "billing_sms_inbound_receipts" ADD COLUMN "quote_id" TEXT;

-- CreateTable
CREATE TABLE "billing_sms_resource_cancellations" (
    "resource_id" VARCHAR(160) NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_sms_resource_cancellations_pkey" PRIMARY KEY ("resource_id")
);

-- CreateTable
CREATE TABLE "billing_sms_dispatch_cancellations" (
    "dispatch_id" VARCHAR(160) NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_sms_dispatch_cancellations_pkey" PRIMARY KEY ("dispatch_id")
);

-- CreateTable
CREATE TABLE "billing_sms_grant_revocations" (
    "grant_id" VARCHAR(160) NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_sms_grant_revocations_pkey" PRIMARY KEY ("grant_id")
);

-- CreateTable
CREATE TABLE "billing_sms_standing_funding" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "hold_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "added_microcredits" BIGINT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_sms_standing_funding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_dispatch_grants" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_token_version" INTEGER NOT NULL,
    "number_id" VARCHAR(160) NOT NULL,
    "allocation_id" VARCHAR(160) NOT NULL,
    "delegate_id" VARCHAR(160) NOT NULL,
    "max_segments" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_sms_dispatch_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_route_policies" (
    "id" TEXT NOT NULL,
    "account_sid" CHAR(34) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "additional_per_segment" DECIMAL(38,18) NOT NULL,
    "additional_per_message" DECIMAL(38,18) NOT NULL,
    "source" VARCHAR(500) NOT NULL,
    "evidence_digest" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_by_user_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptance_reason" VARCHAR(500) NOT NULL,

    CONSTRAINT "billing_sms_route_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_standing_funding_service_id_idempotency_key_key" ON "billing_sms_standing_funding"("service_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_sms_dispatch_grants_service_id_number_id_allocation_idx" ON "billing_sms_dispatch_grants"("service_id", "number_id", "allocation_id", "delegate_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_dispatch_grants_app_key_id_idempotency_key_key" ON "billing_sms_dispatch_grants"("app_key_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_sms_route_policies_account_sid_country_direction_ex_idx" ON "billing_sms_route_policies"("account_sid", "country", "direction", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_entries_sms_reservation_id_key" ON "billing_credit_entries"("sms_reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_entries_sms_inbound_receipt_id_key" ON "billing_credit_entries"("sms_inbound_receipt_id");

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_sms_reservation_id_fkey" FOREIGN KEY ("sms_reservation_id") REFERENCES "billing_sms_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_sms_inbound_receipt_id_fkey" FOREIGN KEY ("sms_inbound_receipt_id") REFERENCES "billing_sms_inbound_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE billing_sms_standing_retirements (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, app_key_id TEXT NOT NULL,
  number_id VARCHAR(160) NOT NULL, allocation_id VARCHAR(160) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX billing_sms_standing_retirements_service_id_number_id_allocation_id_key
  ON billing_sms_standing_retirements(service_id,number_id,allocation_id);
