SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- AlterEnum
ALTER TYPE "BillingAppKeyPurpose" ADD VALUE 'SMS_RUNTIME';

-- AlterTable
ALTER TABLE "billing_recurring_addon_offers" ADD COLUMN     "resource_id" VARCHAR(160),
ADD COLUMN     "resource_kind" VARCHAR(40);

-- CreateTable
CREATE TABLE "billing_sms_fx_snapshots" (
    "id" TEXT NOT NULL,
    "policy" VARCHAR(80) NOT NULL,
    "source" VARCHAR(255) NOT NULL,
    "source_digest" CHAR(64) NOT NULL,
    "rate_date" DATE NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "usd_per_eur" DECIMAL(38,18) NOT NULL,
    "accepted_by_user_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptance_reason" VARCHAR(500) NOT NULL,

    CONSTRAINT "billing_sms_fx_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_quotes" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "destination" VARCHAR(16),
    "provider_amount" DECIMAL(38,18) NOT NULL,
    "provider_currency" CHAR(3) NOT NULL,
    "provider_source" VARCHAR(255) NOT NULL,
    "provider_observed_at" TIMESTAMP(3) NOT NULL,
    "fx_snapshot_id" TEXT NOT NULL,
    "final_amount" DECIMAL(38,18) NOT NULL,
    "final_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "rate_basis" VARCHAR(40) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_sms_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_number_resources" (
    "id" VARCHAR(160) NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "phone_number" VARCHAR(16) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "offer_id" TEXT,
    "checkout_id" TEXT,
    "account_sid" CHAR(34),
    "phone_number_sid" CHAR(34),
    "state" VARCHAR(32) NOT NULL DEFAULT 'payment_required',
    "recovery_reason" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_sms_number_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_reservations" (
    "id" TEXT NOT NULL,
    "dispatch_id" VARCHAR(160) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_token_version" INTEGER NOT NULL,
    "actor_expires_at" TIMESTAMP(3) NOT NULL,
    "number_id" VARCHAR(160) NOT NULL,
    "allocation_id" VARCHAR(160) NOT NULL,
    "quote_id" TEXT NOT NULL,
    "account_sid" CHAR(34) NOT NULL,
    "from" VARCHAR(16) NOT NULL,
    "to" VARCHAR(16) NOT NULL,
    "max_segments" INTEGER NOT NULL,
    "reserved_microcredits" BIGINT NOT NULL,
    "debited_microcredits" BIGINT,
    "actual_amount" DECIMAL(38,18),
    "actual_currency" CHAR(3),
    "message_sid" CHAR(34),
    "dispatch_token_digest" CHAR(64),
    "state" VARCHAR(32) NOT NULL DEFAULT 'reserved',
    "billing_month" CHAR(7) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_sms_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_standing_holds" (
    "id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "number_id" VARCHAR(160) NOT NULL,
    "allocation_id" VARCHAR(160) NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "reserved_microcredits" BIGINT NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_sms_standing_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_sms_inbound_receipts" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "number_id" VARCHAR(160) NOT NULL,
    "allocation_id" VARCHAR(160) NOT NULL,
    "account_sid" CHAR(34) NOT NULL,
    "message_sid" CHAR(34) NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "standing_hold_id" TEXT,
    "actual_amount" DECIMAL(38,18),
    "actual_currency" CHAR(3),
    "consumed_microcredits" BIGINT,
    "uncollected_microcredits" BIGINT,
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_sms_inbound_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_sms_fx_snapshots_expires_at_accepted_at_idx" ON "billing_sms_fx_snapshots"("expires_at", "accepted_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_fx_snapshots_policy_source_digest_key" ON "billing_sms_fx_snapshots"("policy", "source_digest");

-- CreateIndex
CREATE INDEX "billing_sms_quotes_service_id_org_id_expires_at_idx" ON "billing_sms_quotes"("service_id", "org_id", "expires_at");

-- CreateIndex
CREATE INDEX "billing_sms_number_resources_service_id_org_id_state_idx" ON "billing_sms_number_resources"("service_id", "org_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_number_resources_service_id_account_sid_phone_n_key" ON "billing_sms_number_resources"("service_id", "account_sid", "phone_number_sid");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_reservations_dispatch_id_key" ON "billing_sms_reservations"("dispatch_id");

-- CreateIndex
CREATE INDEX "billing_sms_reservations_credit_account_id_state_idx" ON "billing_sms_reservations"("credit_account_id", "state");

-- CreateIndex
CREATE INDEX "billing_sms_reservations_org_id_team_id_billing_month_idx" ON "billing_sms_reservations"("org_id", "team_id", "billing_month");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_reservations_account_sid_message_sid_key" ON "billing_sms_reservations"("account_sid", "message_sid");

-- CreateIndex
CREATE INDEX "billing_sms_standing_holds_credit_account_id_state_idx" ON "billing_sms_standing_holds"("credit_account_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_standing_holds_service_id_number_id_allocation__key" ON "billing_sms_standing_holds"("service_id", "number_id", "allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_standing_holds_app_key_id_idempotency_key_key" ON "billing_sms_standing_holds"("app_key_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_sms_inbound_receipts_service_id_number_id_allocatio_idx" ON "billing_sms_inbound_receipts"("service_id", "number_id", "allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_sms_inbound_receipts_account_sid_message_sid_key" ON "billing_sms_inbound_receipts"("account_sid", "message_sid");

-- AddForeignKey
ALTER TABLE "billing_sms_quotes" ADD CONSTRAINT "billing_sms_quotes_fx_snapshot_id_fkey" FOREIGN KEY ("fx_snapshot_id") REFERENCES "billing_sms_fx_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_sms_number_resources" ADD CONSTRAINT "billing_sms_number_resources_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "billing_sms_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_sms_reservations" ADD CONSTRAINT "billing_sms_reservations_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_sms_reservations" ADD CONSTRAINT "billing_sms_reservations_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "billing_sms_number_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_sms_reservations" ADD CONSTRAINT "billing_sms_reservations_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "billing_sms_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_sms_standing_holds" ADD CONSTRAINT "billing_sms_standing_holds_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_sms_standing_holds" ADD CONSTRAINT "billing_sms_standing_holds_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "billing_sms_number_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial evidence is never accessible through tenant session RLS.
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'billing_sms_fx_snapshots', 'billing_sms_quotes', 'billing_sms_number_resources',
    'billing_sms_reservations', 'billing_sms_standing_holds', 'billing_sms_inbound_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

ALTER TABLE billing_sms_fx_snapshots
  ADD CONSTRAINT sms_fx_actor_fk FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_fx_positive CHECK (usd_per_eur > 0 AND expires_at > observed_at);

DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_sms_quotes', 'billing_sms_number_resources',
    'billing_sms_reservations', 'billing_sms_standing_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT',
      table_name, table_name || '_service_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (app_key_id) REFERENCES billing_app_keys(id) ON DELETE RESTRICT',
      table_name, table_name || '_key_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT',
      table_name, table_name || '_org_fk');
  END LOOP;
END $$;

ALTER TABLE billing_sms_quotes ADD CONSTRAINT sms_quote_shape CHECK (
  provider_amount >= 0 AND final_amount >= 0 AND final_currency = 'USD'
  AND country ~ '^[A-Z]{2}$'
  AND ((direction = 'monthly' AND destination IS NULL AND rate_basis = 'monthly_mobile')
    OR (direction = 'inbound' AND destination IS NULL AND rate_basis = 'inbound_mobile')
    OR (direction = 'outbound' AND destination ~ '^\+[1-9][0-9]{6,14}$'
      AND rate_basis = 'maximum_mobile_carrier')));
ALTER TABLE billing_sms_number_resources
  ADD CONSTRAINT sms_number_offer_fk FOREIGN KEY (offer_id) REFERENCES billing_recurring_addon_offers(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_number_checkout_fk FOREIGN KEY (checkout_id) REFERENCES billing_recurring_addon_checkouts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_number_state CHECK (state IN ('payment_required','payment_pending','paid','active',
    'ending','ended','recovery_required','refund_required'));
ALTER TABLE billing_sms_reservations
  ADD CONSTRAINT sms_reservation_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_reservation_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_reservation_amount CHECK (reserved_microcredits >= 0 AND max_segments BETWEEN 1 AND 100
    AND (debited_microcredits IS NULL OR debited_microcredits BETWEEN 0 AND reserved_microcredits)),
  ADD CONSTRAINT sms_reservation_state CHECK (state IN ('reserved','dispatching','uncertain','settled','released','reconciliation'));
ALTER TABLE billing_sms_standing_holds
  ADD CONSTRAINT sms_standing_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_standing_user_fk FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_standing_amount CHECK (reserved_microcredits >= 0),
  ADD CONSTRAINT sms_standing_state CHECK (state IN ('active','retired','reconciliation'));
ALTER TABLE billing_sms_inbound_receipts
  ADD CONSTRAINT sms_inbound_number_fk FOREIGN KEY (number_id) REFERENCES billing_sms_number_resources(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_inbound_hold_fk FOREIGN KEY (standing_hold_id) REFERENCES billing_sms_standing_holds(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_inbound_state CHECK (state IN ('pending','funded','uncollected','reconciliation'));

CREATE FUNCTION billing_sms_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SMS pricing evidence is immutable'; END $$;
CREATE TRIGGER sms_fx_immutable BEFORE UPDATE OR DELETE ON billing_sms_fx_snapshots
  FOR EACH ROW EXECUTE FUNCTION billing_sms_immutable_evidence();
CREATE TRIGGER sms_quote_immutable BEFORE UPDATE OR DELETE ON billing_sms_quotes
  FOR EACH ROW EXECUTE FUNCTION billing_sms_immutable_evidence();

CREATE FUNCTION billing_total_reserved_microcredits(account_id TEXT) RETURNS BIGINT
LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(SUM(amount),0)::BIGINT FROM (
    SELECT reserved_microcredits AS amount FROM billing_prepaid_reservations
      WHERE credit_account_id = account_id AND status = 'ACTIVE'
    UNION ALL
    SELECT reserved_microcredits FROM billing_sms_reservations
      WHERE credit_account_id = account_id AND state IN ('reserved','dispatching','uncertain','reconciliation')
    UNION ALL
    SELECT reserved_microcredits FROM billing_sms_standing_holds WHERE credit_account_id = account_id
  ) held
$$;

CREATE OR REPLACE FUNCTION billing_prepaid_protect_reserved_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held BIGINT;
BEGIN
  held := billing_total_reserved_microcredits(NEW.id);
  IF held > 0 AND NEW.balance_microcredits < held THEN
    RAISE EXCEPTION 'prepaid reserved balance cannot be consumed';
  END IF;
  RETURN NEW;
END $$;

-- Serialize hold creation with every balance mutation, including ordinary AI reservations.
CREATE FUNCTION billing_sms_hold_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance BIGINT; held BIGINT;
BEGIN
  SELECT balance_microcredits INTO balance FROM billing_credit_accounts
    WHERE id = NEW.credit_account_id FOR UPDATE;
  held := billing_total_reserved_microcredits(NEW.credit_account_id);
  IF TG_OP = 'UPDATE' THEN held := held - OLD.reserved_microcredits; END IF;
  IF NEW.reserved_microcredits > 0 AND balance < held + NEW.reserved_microcredits THEN
    RAISE EXCEPTION 'insufficient available prepaid credits';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_standing_hold_admission BEFORE INSERT OR UPDATE OF reserved_microcredits ON billing_sms_standing_holds
  FOR EACH ROW EXECUTE FUNCTION billing_sms_hold_admission();
CREATE TRIGGER sms_dispatch_hold_admission BEFORE INSERT ON billing_sms_reservations
  FOR EACH ROW EXECUTE FUNCTION billing_sms_hold_admission();
CREATE TRIGGER ai_dispatch_shared_hold_admission BEFORE INSERT ON billing_prepaid_reservations
  FOR EACH ROW EXECUTE FUNCTION billing_sms_hold_admission();
