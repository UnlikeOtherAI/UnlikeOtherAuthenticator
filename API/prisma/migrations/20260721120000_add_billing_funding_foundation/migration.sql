-- CreateEnum
CREATE TYPE "BillingCreditEntryDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "BillingCreditEntryKind" AS ENUM ('TOP_UP', 'AUTOMATIC_TOP_UP', 'USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION', 'REFUND', 'DISPUTE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BillingCreditPaymentAdjustmentKind" AS ENUM ('REFUND', 'DISPUTE');

-- CreateEnum
CREATE TYPE "BillingCreditAutoTopUpState" AS ENUM ('DISABLED', 'ACTIVE', 'PAUSED', 'REQUIRES_ACTION', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "BillingCreditAutoTopUpConsentSource" AS ENUM ('SETUP_CHECKOUT', 'CUSTOMER_UPDATE');

-- CreateEnum
CREATE TYPE "BillingCreditCheckoutStatus" AS ENUM ('CREATING', 'OPEN', 'COMPLETE', 'EXPIRED', 'ABANDONED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "BillingCreditAutoTopUpAttemptStatus" AS ENUM ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "BillingCreditUsageSettlementStatus" AS ENUM ('PENDING', 'APPLIED', 'REVERSED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "BillingCreditInvoiceLineStatus" AS ENUM ('CREATING', 'APPLIED', 'REMOVED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "BillingRecurringAddonEntitlementScope" AS ENUM ('ORGANISATION', 'TEAM', 'SUBSCRIBING_USER');

-- Add-on purchase/entitlement scope is independent of tariff assignment scope.
CREATE TYPE "BillingRecurringAddonSubscriptionScope" AS ENUM ('ORGANISATION', 'TEAM', 'SUBSCRIBING_USER');

-- CreateEnum
CREATE TYPE "BillingRecurringAddonCheckoutStatus" AS ENUM ('CREATING', 'OPEN', 'COMPLETE', 'EXPIRED', 'ABANDONED', 'NEEDS_REVIEW');

CREATE TYPE "BillingRecurringAddonCancellationIntentState" AS ENUM ('AVAILABLE', 'PROCESSING', 'COMPLETED', 'EXPIRED');

-- Parsed facts from Stripe-signed events. Unrelated event types may leave these
-- null; financial transitions below require the exact relevant fact set.
ALTER TABLE "billing_stripe_webhook_events"
  ADD COLUMN "stripe_object_id" VARCHAR(255),
  ADD COLUMN "stripe_customer_id" VARCHAR(255),
  ADD COLUMN "stripe_checkout_session_id" VARCHAR(255),
  ADD COLUMN "stripe_payment_intent_id" VARCHAR(255),
  ADD COLUMN "stripe_charge_id" VARCHAR(255),
  ADD COLUMN "stripe_setup_intent_id" VARCHAR(255),
  ADD COLUMN "stripe_payment_method_id" VARCHAR(255),
  ADD COLUMN "stripe_subscription_id" VARCHAR(255),
  ADD COLUMN "stripe_subscription_item_id" VARCHAR(255),
  ADD COLUMN "stripe_invoice_id" VARCHAR(255),
  ADD COLUMN "amount_minor" BIGINT,
  ADD COLUMN "currency" CHAR(3);

-- CreateTable
CREATE TABLE "billing_credit_funding_policies" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "top_up_enabled" BOOLEAN NOT NULL DEFAULT false,
    "automatic_top_up_enabled" BOOLEAN NOT NULL DEFAULT false,
    "automatic_consent_version" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_funding_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_top_up_offers" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "catalog_key" VARCHAR(100) NOT NULL,
    "catalog_version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "payment_amount_minor" BIGINT NOT NULL,
    "credits_received_microcredits" BIGINT NOT NULL,
    "automatic_top_up_eligible" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_top_up_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_auto_top_up_options" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "refill_offer_id" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "threshold_microcredits" BIGINT NOT NULL,
    "monthly_charge_cap_minor" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_auto_top_up_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_top_up_catalogs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_amount_minor" BIGINT NOT NULL,
    "credits_received_microcredits" BIGINT NOT NULL,
    "stripe_lookup_key" VARCHAR(200) NOT NULL,
    "stripe_product_id" VARCHAR(255),
    "stripe_price_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_top_up_catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "balance_microcredits" BIGINT NOT NULL DEFAULT 0,
    "auto_top_up_state" "BillingCreditAutoTopUpState" NOT NULL DEFAULT 'DISABLED',
    "auto_top_up_policy_id" TEXT,
    "auto_top_up_service_id" TEXT,
    "auto_top_up_app_key_id" TEXT,
    "auto_top_up_consent_revision_id" TEXT,
    "auto_top_up_option_id" TEXT,
    "auto_top_up_threshold_microcredits" BIGINT,
    "auto_top_up_refill_offer_id" TEXT,
    "auto_top_up_monthly_charge_cap_minor" BIGINT,
    "auto_top_up_consent_version" VARCHAR(120),
    "auto_top_up_consented_at" TIMESTAMP(3),
    "auto_top_up_consented_by_user_id" TEXT,
    "stripe_payment_method_id" VARCHAR(255),
    "payment_method_summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_entries" (
    "id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "service_id" TEXT,
    "app_key_id" TEXT,
    "attributed_user_id" TEXT,
    "direction" "BillingCreditEntryDirection" NOT NULL,
    "kind" "BillingCreditEntryKind" NOT NULL,
    "amount_microcredits" BIGINT NOT NULL,
    "balance_after_microcredits" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "source_type" VARCHAR(80) NOT NULL,
    "source_id" VARCHAR(255) NOT NULL,
    "reverses_entry_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_admin_adjustments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "signed_amount_microcredits" BIGINT NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_by_email" VARCHAR(320) NOT NULL,
    "created_by_admin_domain" VARCHAR(255) NOT NULL,
    "credit_entry_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_admin_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_payment_adjustments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "kind" "BillingCreditPaymentAdjustmentKind" NOT NULL,
    "original_entry_id" TEXT NOT NULL,
    "webhook_event_id" TEXT NOT NULL,
    "stripe_object_id" VARCHAR(255) NOT NULL,
    "stripe_payment_intent_id" VARCHAR(255) NOT NULL,
    "stripe_charge_id" VARCHAR(255) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "amount_microcredits" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "livemode" BOOLEAN NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "credit_entry_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_payment_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_portfolio_snapshots" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "perspective_service_id" TEXT NOT NULL,
    "perspective_product" VARCHAR(100) NOT NULL,
    "billing_month" CHAR(7) NOT NULL,
    "contract" VARCHAR(80) NOT NULL DEFAULT 'metering-portfolio-v1',
    "group_by" VARCHAR(32) NOT NULL DEFAULT 'user',
    "ledger_snapshot_id" VARCHAR(80) NOT NULL,
    "ledger_snapshot_cursor" VARCHAR(80) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_top_up_checkouts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "actor_jti" VARCHAR(256) NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "payment_amount_minor" BIGINT NOT NULL,
    "credits_received_microcredits" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "success_url_digest" CHAR(64) NOT NULL,
    "cancel_url_digest" CHAR(64) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255),
    "stripe_payment_intent_id" VARCHAR(255),
    "completion_webhook_event_id" TEXT,
    "status" "BillingCreditCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "credit_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_top_up_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_setup_checkouts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,
    "actor_jti" VARCHAR(256) NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "consent_version" VARCHAR(120) NOT NULL,
    "threshold_microcredits" BIGINT NOT NULL,
    "refill_offer_id" TEXT NOT NULL,
    "refill_credits_microcredits" BIGINT NOT NULL,
    "refill_payment_amount_minor" BIGINT NOT NULL,
    "monthly_charge_cap_minor" BIGINT NOT NULL,
    "success_url_digest" CHAR(64) NOT NULL,
    "cancel_url_digest" CHAR(64) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255),
    "stripe_setup_intent_id" VARCHAR(255),
    "stripe_payment_method_id" VARCHAR(255),
    "completion_webhook_event_id" TEXT,
    "status" "BillingCreditCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_setup_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_auto_top_up_consent_revisions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,
    "refill_offer_id" TEXT NOT NULL,
    "setup_checkout_id" TEXT,
    "source" "BillingCreditAutoTopUpConsentSource" NOT NULL,
    "actor_jti" VARCHAR(256) NOT NULL,
    "consented_by_user_id" TEXT NOT NULL,
    "consent_version" VARCHAR(120) NOT NULL,
    "threshold_microcredits" BIGINT NOT NULL,
    "refill_credits_microcredits" BIGINT NOT NULL,
    "refill_payment_amount_minor" BIGINT NOT NULL,
    "monthly_charge_cap_minor" BIGINT NOT NULL,
    "stripe_payment_method_id" VARCHAR(255) NOT NULL,
    "payment_method_summary" JSONB,
    "consented_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_auto_top_up_consent_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_auto_top_up_attempts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "attributed_user_id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "trigger_entry_id" TEXT,
    "consent_revision_id" TEXT NOT NULL,
    "consent_version" VARCHAR(120) NOT NULL,
    "threshold_microcredits" BIGINT NOT NULL,
    "monthly_charge_cap_minor" BIGINT NOT NULL,
    "charged_this_month_before_minor" BIGINT NOT NULL,
    "observed_balance_microcredits" BIGINT NOT NULL,
    "payment_amount_minor" BIGINT NOT NULL,
    "credits_received_microcredits" BIGINT NOT NULL,
    "billing_month" CHAR(7) NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "stripe_payment_intent_id" VARCHAR(255),
    "success_webhook_event_id" TEXT,
    "status" "BillingCreditAutoTopUpAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "failure_code" VARCHAR(120),
    "credit_entry_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_auto_top_up_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_usage_settlements" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "tariff_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "billing_month" CHAR(7) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "cumulative_rated_usage_amount_micro_minor" BIGINT NOT NULL DEFAULT 0,
    "cumulative_credits_consumed_microcredits" BIGINT NOT NULL DEFAULT 0,
    "cumulative_remaining_usage_amount_micro_minor" BIGINT NOT NULL DEFAULT 0,
    "status" "BillingCreditUsageSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_usage_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_usage_settlement_adjustments" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "portfolio_snapshot_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "delta_rated_usage_amount_micro_minor" BIGINT NOT NULL,
    "delta_credits_consumed_microcredits" BIGINT NOT NULL,
    "delta_remaining_usage_amount_micro_minor" BIGINT NOT NULL,
    "cumulative_rated_usage_amount_micro_minor" BIGINT NOT NULL,
    "cumulative_credits_consumed_microcredits" BIGINT NOT NULL,
    "cumulative_remaining_usage_amount_micro_minor" BIGINT NOT NULL,
    "credit_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_usage_settlement_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_usage_allocations" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "adjustment_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "attributed_user_id" TEXT,
    "delta_rated_usage_amount_micro_minor" BIGINT NOT NULL,
    "delta_credits_consumed_microcredits" BIGINT NOT NULL,
    "delta_remaining_usage_amount_micro_minor" BIGINT NOT NULL,
    "cumulative_rated_usage_amount_micro_minor" BIGINT NOT NULL,
    "cumulative_credits_consumed_microcredits" BIGINT NOT NULL,
    "cumulative_remaining_usage_amount_micro_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_usage_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_invoice_lines" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "last_adjustment_id" TEXT NOT NULL,
    "stripe_invoice_id" VARCHAR(255) NOT NULL,
    "stripe_invoice_item_id" VARCHAR(255),
    "cumulative_credits_consumed_microcredits" BIGINT NOT NULL,
    "stripe_unit_amount_decimal" VARCHAR(20) NOT NULL DEFAULT '-0.000001',
    "stripe_quantity" BIGINT NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "status" "BillingCreditInvoiceLineStatus" NOT NULL DEFAULT 'CREATING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_recurring_addon_offers" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthly_amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_recurring_addon_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_recurring_addon_feature_policies" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "feature_flag_key" VARCHAR(80) NOT NULL,
    "entitlement_scope" "BillingRecurringAddonEntitlementScope" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_recurring_addon_feature_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_recurring_addon_catalogs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "monthly_amount_minor" BIGINT NOT NULL,
    "stripe_lookup_key" VARCHAR(200) NOT NULL,
    "stripe_product_id" VARCHAR(255),
    "stripe_price_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_recurring_addon_catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_recurring_addon_checkouts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "offer_key" VARCHAR(80) NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "requested_team_id" TEXT NOT NULL,
    "subscribing_user_id" TEXT,
    "scope" "BillingRecurringAddonSubscriptionScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "actor_jti" VARCHAR(256) NOT NULL,
    "subject_fingerprint" CHAR(64) NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "success_url_digest" CHAR(64) NOT NULL,
    "cancel_url_digest" CHAR(64) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255),
    "stripe_subscription_id" VARCHAR(255),
    "completion_webhook_event_id" TEXT,
    "status" "BillingRecurringAddonCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_recurring_addon_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_recurring_addon_subscriptions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "offer_key" VARCHAR(80) NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "subscribing_user_id" TEXT,
    "scope" "BillingRecurringAddonSubscriptionScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "stripe_subscription_id" VARCHAR(255) NOT NULL,
    "stripe_item_id" VARCHAR(255) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "initial_invoice_paid_at" TIMESTAMP(3),
    "initial_invoice_id" VARCHAR(255),
    "activation_webhook_event_id" TEXT,
    "entitlement_activated_at" TIMESTAMP(3),
    "entitlement_deactivated_at" TIMESTAMP(3),
    "livemode" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_recurring_addon_subscriptions_pkey" PRIMARY KEY ("id")
);

-- Cancellation previews are opaque, single-use capabilities bound to one
-- exact add-on subscription and one authenticated product actor.
CREATE TABLE "billing_recurring_addon_cancellation_intents" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "requested_team_id" TEXT NOT NULL,
    "subscribing_user_id" TEXT,
    "scope" "BillingRecurringAddonSubscriptionScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "actor_jti" VARCHAR(256) NOT NULL,
    "token_digest" CHAR(64) NOT NULL,
    "subject_fingerprint" CHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "choice" VARCHAR(32) NOT NULL DEFAULT 'cancel_addon',
    "state" "BillingRecurringAddonCancellationIntentState" NOT NULL DEFAULT 'AVAILABLE',
    "confirmation_request_digest" CHAR(64),
    "result" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_recurring_addon_cancellation_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_credit_funding_policies_service_id_active_idx" ON "billing_credit_funding_policies"("service_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_funding_policies_service_id_currency_version_key" ON "billing_credit_funding_policies"("service_id", "currency", "version");

-- CreateIndex
CREATE INDEX "billing_credit_top_up_offers_service_id_active_idx" ON "billing_credit_top_up_offers"("service_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_offers_policy_id_key_version_key" ON "billing_credit_top_up_offers"("policy_id", "key", "version");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_options_service_id_active_idx" ON "billing_credit_auto_top_up_options"("service_id", "active");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_options_refill_offer_id_idx" ON "billing_credit_auto_top_up_options"("refill_offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_auto_top_up_options_policy_id_key_version_key" ON "billing_credit_auto_top_up_options"("policy_id", "key", "version");

-- CreateIndex
CREATE INDEX "billing_credit_top_up_catalogs_account_id_stripe_product_id_idx" ON "billing_credit_top_up_catalogs"("account_id", "stripe_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_catalogs_account_id_key_version_key" ON "billing_credit_top_up_catalogs"("account_id", "key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_catalogs_account_id_stripe_lookup_key_key" ON "billing_credit_top_up_catalogs"("account_id", "stripe_lookup_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_catalogs_account_id_stripe_price_id_key" ON "billing_credit_top_up_catalogs"("account_id", "stripe_price_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_org_id_team_id_idx" ON "billing_credit_accounts"("org_id", "team_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_customer_id_idx" ON "billing_credit_accounts"("customer_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_auto_top_up_policy_id_idx" ON "billing_credit_accounts"("auto_top_up_policy_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_auto_top_up_service_id_idx" ON "billing_credit_accounts"("auto_top_up_service_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_auto_top_up_app_key_id_idx" ON "billing_credit_accounts"("auto_top_up_app_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_accounts_auto_top_up_consent_revision_id_key" ON "billing_credit_accounts"("auto_top_up_consent_revision_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_auto_top_up_consent_revision_idx" ON "billing_credit_accounts"("auto_top_up_consent_revision_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_auto_top_up_option_id_idx" ON "billing_credit_accounts"("auto_top_up_option_id");

-- CreateIndex
CREATE INDEX "billing_credit_accounts_auto_top_up_consented_by_user_id_idx" ON "billing_credit_accounts"("auto_top_up_consented_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_accounts_account_id_team_id_currency_key" ON "billing_credit_accounts"("account_id", "team_id", "currency");

-- CreateIndex
CREATE INDEX "billing_credit_entries_reverses_entry_id_idx" ON "billing_credit_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "billing_credit_entries_credit_account_id_occurred_at_idx" ON "billing_credit_entries"("credit_account_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_credit_entries_service_id_attributed_user_id_occurr_idx" ON "billing_credit_entries"("service_id", "attributed_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_credit_entries_app_key_id_idx" ON "billing_credit_entries"("app_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_entries_credit_account_id_idempotency_key_key" ON "billing_credit_entries"("credit_account_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_admin_adjustments_credit_entry_id_key" ON "billing_credit_admin_adjustments"("credit_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_admin_adjustments_account_idempotency_key" ON "billing_credit_admin_adjustments"("credit_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_credit_admin_adjustments_account_id_idx" ON "billing_credit_admin_adjustments"("account_id");

-- CreateIndex
CREATE INDEX "billing_credit_admin_adjustments_org_team_created_idx" ON "billing_credit_admin_adjustments"("org_id", "team_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_credit_admin_adjustments_creator_idx" ON "billing_credit_admin_adjustments"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_adjustments_credit_entry_id_key" ON "billing_credit_payment_adjustments"("credit_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_adjustments_remote_key" ON "billing_credit_payment_adjustments"("account_id", "kind", "stripe_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_payment_adjustments_idempotency_key" ON "billing_credit_payment_adjustments"("credit_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_credit_payment_adjustments_original_idx" ON "billing_credit_payment_adjustments"("original_entry_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_credit_payment_adjustments_webhook_idx" ON "billing_credit_payment_adjustments"("webhook_event_id");

-- CreateIndex
CREATE INDEX "billing_credit_payment_adjustments_payment_intent_idx" ON "billing_credit_payment_adjustments"("account_id", "stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "billing_credit_payment_adjustments_service_id_idx" ON "billing_credit_payment_adjustments"("service_id");

-- CreateIndex
CREATE INDEX "billing_credit_payment_adjustments_app_key_id_idx" ON "billing_credit_payment_adjustments"("app_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_ledger_id_key" ON "billing_credit_portfolio_snapshots"("credit_account_id", "ledger_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_cursor_key" ON "billing_credit_portfolio_snapshots"("credit_account_id", "ledger_snapshot_cursor");

-- CreateIndex
CREATE INDEX "billing_credit_portfolio_snapshots_account_id_idx" ON "billing_credit_portfolio_snapshots"("account_id");

-- CreateIndex
CREATE INDEX "billing_credit_portfolio_snapshot_order_idx" ON "billing_credit_portfolio_snapshots"("org_id", "team_id", "billing_month", "captured_at");

-- CreateIndex
CREATE INDEX "billing_credit_portfolio_snapshot_perspective_idx" ON "billing_credit_portfolio_snapshots"("perspective_service_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_checkouts_credit_entry_id_key" ON "billing_credit_top_up_checkouts"("credit_entry_id");

-- CreateIndex
CREATE INDEX "billing_credit_top_up_checkouts_credit_account_id_status_idx" ON "billing_credit_top_up_checkouts"("credit_account_id", "status");

-- CreateIndex
CREATE INDEX "billing_credit_top_up_checkouts_app_key_id_actor_jti_idx" ON "billing_credit_top_up_checkouts"("app_key_id", "actor_jti");

-- CreateIndex
CREATE INDEX "billing_credit_top_up_checkouts_requested_by_user_id_idx" ON "billing_credit_top_up_checkouts"("requested_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_checkouts_account_id_stripe_checkout__key" ON "billing_credit_top_up_checkouts"("account_id", "stripe_checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_top_up_checkouts_account_id_stripe_payment_i_key" ON "billing_credit_top_up_checkouts"("account_id", "stripe_payment_intent_id");

CREATE UNIQUE INDEX "billing_credit_top_up_checkouts_completion_event_key" ON "billing_credit_top_up_checkouts"("completion_webhook_event_id");

-- CreateIndex
CREATE INDEX "billing_credit_setup_checkouts_credit_account_id_status_idx" ON "billing_credit_setup_checkouts"("credit_account_id", "status");

-- CreateIndex
CREATE INDEX "billing_credit_setup_checkouts_app_key_id_actor_jti_idx" ON "billing_credit_setup_checkouts"("app_key_id", "actor_jti");

-- CreateIndex
CREATE INDEX "billing_credit_setup_checkouts_requested_by_user_id_idx" ON "billing_credit_setup_checkouts"("requested_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_setup_checkouts_account_id_stripe_checkout_s_key" ON "billing_credit_setup_checkouts"("account_id", "stripe_checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_setup_checkouts_account_id_stripe_setup_inte_key" ON "billing_credit_setup_checkouts"("account_id", "stripe_setup_intent_id");

CREATE UNIQUE INDEX "billing_credit_setup_checkouts_completion_event_key" ON "billing_credit_setup_checkouts"("completion_webhook_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_consent_revisions_setup_checkout_id_key" ON "billing_credit_auto_top_up_consent_revisions"("setup_checkout_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_consent_revisions_app_key_actor_jti_key" ON "billing_credit_auto_top_up_consent_revisions"("app_key_id", "actor_jti");

-- CreateIndex
CREATE INDEX "billing_credit_consent_revisions_credit_account_at_idx" ON "billing_credit_auto_top_up_consent_revisions"("credit_account_id", "consented_at");

-- CreateIndex
CREATE INDEX "billing_credit_consent_revisions_org_team_idx" ON "billing_credit_auto_top_up_consent_revisions"("org_id", "team_id");

-- CreateIndex
CREATE INDEX "billing_credit_consent_revisions_policy_id_idx" ON "billing_credit_auto_top_up_consent_revisions"("policy_id");

-- CreateIndex
CREATE INDEX "billing_credit_consent_revisions_option_id_idx" ON "billing_credit_auto_top_up_consent_revisions"("option_id");

-- CreateIndex
CREATE INDEX "billing_credit_consent_revisions_refill_offer_id_idx" ON "billing_credit_auto_top_up_consent_revisions"("refill_offer_id");

-- CreateIndex
CREATE INDEX "billing_credit_consent_revisions_consenter_idx" ON "billing_credit_auto_top_up_consent_revisions"("consented_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_auto_top_up_attempts_credit_entry_id_key" ON "billing_credit_auto_top_up_attempts"("credit_entry_id");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_attempts_credit_account_id_statu_idx" ON "billing_credit_auto_top_up_attempts"("credit_account_id", "status");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_attempts_service_id_attributed_u_idx" ON "billing_credit_auto_top_up_attempts"("service_id", "attributed_user_id");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_attempts_app_key_id_idx" ON "billing_credit_auto_top_up_attempts"("app_key_id");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_attempts_trigger_entry_id_idx" ON "billing_credit_auto_top_up_attempts"("trigger_entry_id");

-- CreateIndex
CREATE INDEX "billing_credit_auto_top_up_attempts_consent_revision_id_idx" ON "billing_credit_auto_top_up_attempts"("consent_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_auto_top_up_attempts_credit_account_id_idemp_key" ON "billing_credit_auto_top_up_attempts"("credit_account_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_auto_top_up_attempts_account_id_stripe_payme_key" ON "billing_credit_auto_top_up_attempts"("account_id", "stripe_payment_intent_id");

CREATE UNIQUE INDEX "billing_credit_auto_top_up_attempts_success_event_key" ON "billing_credit_auto_top_up_attempts"("success_webhook_event_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlements_account_id_idx" ON "billing_credit_usage_settlements"("account_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlements_credit_account_id_billing__idx" ON "billing_credit_usage_settlements"("credit_account_id", "billing_month");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlements_app_key_id_idx" ON "billing_credit_usage_settlements"("app_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_usage_settlements_credit_account_id_service__key" ON "billing_credit_usage_settlements"("credit_account_id", "service_id", "billing_month");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_usage_settlement_adjustments_credit_entry_id_key" ON "billing_credit_usage_settlement_adjustments"("credit_entry_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlement_adjustments_account_id_idx" ON "billing_credit_usage_settlement_adjustments"("account_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlement_adjustments_credit_account__idx" ON "billing_credit_usage_settlement_adjustments"("credit_account_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlement_adjustments_service_id_idx" ON "billing_credit_usage_settlement_adjustments"("service_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_settlement_adjustments_app_key_id_idx" ON "billing_credit_usage_settlement_adjustments"("app_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_usage_adjustments_settlement_snapshot_key" ON "billing_credit_usage_settlement_adjustments"("settlement_id", "portfolio_snapshot_id");

CREATE UNIQUE INDEX "billing_credit_usage_settlement_adjustments_settlement_id_sequence_key" ON "billing_credit_usage_settlement_adjustments"("settlement_id", "sequence");

-- CreateIndex
CREATE INDEX "billing_credit_usage_allocations_settlement_id_attributed_u_idx" ON "billing_credit_usage_allocations"("settlement_id", "attributed_user_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_credit_usage_allocations_service_id_idx" ON "billing_credit_usage_allocations"("service_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_allocations_app_key_id_idx" ON "billing_credit_usage_allocations"("app_key_id");

-- CreateIndex
CREATE INDEX "billing_credit_usage_allocations_adjustment_id_attributed_u_idx" ON "billing_credit_usage_allocations"("adjustment_id", "attributed_user_id");

CREATE UNIQUE INDEX "billing_credit_usage_allocations_one_subject_per_adjustment"
  ON "billing_credit_usage_allocations"(
    "adjustment_id",
    COALESCE("attributed_user_id", '__uoa_unattributed__')
  );

-- CreateIndex
CREATE INDEX "billing_credit_invoice_lines_account_id_stripe_invoice_id_idx" ON "billing_credit_invoice_lines"("account_id", "stripe_invoice_id");

-- CreateIndex
CREATE INDEX "billing_credit_invoice_lines_subscription_id_idx" ON "billing_credit_invoice_lines"("subscription_id");

-- CreateIndex
CREATE INDEX "billing_credit_invoice_lines_last_adjustment_id_idx" ON "billing_credit_invoice_lines"("last_adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_invoice_lines_settlement_id_stripe_invoice_i_key" ON "billing_credit_invoice_lines"("settlement_id", "stripe_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_invoice_lines_account_id_stripe_invoice_item_key" ON "billing_credit_invoice_lines"("account_id", "stripe_invoice_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_invoice_lines_account_id_idempotency_key_key" ON "billing_credit_invoice_lines"("account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_offers_service_id_active_idx" ON "billing_recurring_addon_offers"("service_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_offers_service_id_key_version_key" ON "billing_recurring_addon_offers"("service_id", "key", "version");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_feature_policies_service_id_active_idx" ON "billing_recurring_addon_feature_policies"("service_id", "active");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_feature_policies_app_id_feature_fla_idx" ON "billing_recurring_addon_feature_policies"("app_id", "feature_flag_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_feature_policies_offer_id_app_id_fe_key" ON "billing_recurring_addon_feature_policies"("offer_id", "app_id", "feature_flag_key", "entitlement_scope");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_catalogs_service_id_idx" ON "billing_recurring_addon_catalogs"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_catalogs_account_id_offer_id_key" ON "billing_recurring_addon_catalogs"("account_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_catalogs_account_id_stripe_lookup_k_key" ON "billing_recurring_addon_catalogs"("account_id", "stripe_lookup_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_catalogs_account_id_stripe_product__key" ON "billing_recurring_addon_catalogs"("account_id", "stripe_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_catalogs_account_id_stripe_price_id_key" ON "billing_recurring_addon_catalogs"("account_id", "stripe_price_id");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_checkouts_account_id_service_id_off_idx" ON "billing_recurring_addon_checkouts"("account_id", "service_id", "offer_id", "scope", "scope_key");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_checkouts_app_key_id_actor_jti_idx" ON "billing_recurring_addon_checkouts"("app_key_id", "actor_jti");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_checkouts_customer_id_idx" ON "billing_recurring_addon_checkouts"("customer_id");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_checkouts_org_id_idx" ON "billing_recurring_addon_checkouts"("org_id");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_checkouts_team_id_idx" ON "billing_recurring_addon_checkouts"("team_id");

CREATE INDEX "billing_recurring_addon_checkouts_requested_team_id_idx" ON "billing_recurring_addon_checkouts"("requested_team_id");

CREATE INDEX "billing_recurring_addon_checkouts_subscribing_user_idx" ON "billing_recurring_addon_checkouts"("subscribing_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_checkouts_account_id_stripe_checkou_key" ON "billing_recurring_addon_checkouts"("account_id", "stripe_checkout_session_id");

CREATE UNIQUE INDEX "billing_recurring_addon_checkouts_account_subscription_key" ON "billing_recurring_addon_checkouts"("account_id", "stripe_subscription_id");

CREATE UNIQUE INDEX "billing_recurring_addon_checkouts_completion_event_key" ON "billing_recurring_addon_checkouts"("completion_webhook_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_subscriptions_checkout_id_key" ON "billing_recurring_addon_subscriptions"("checkout_id");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_subscriptions_account_id_service_id_idx" ON "billing_recurring_addon_subscriptions"("account_id", "service_id", "offer_id", "scope", "scope_key");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_subscriptions_customer_id_idx" ON "billing_recurring_addon_subscriptions"("customer_id");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_subscriptions_org_id_idx" ON "billing_recurring_addon_subscriptions"("org_id");

-- CreateIndex
CREATE INDEX "billing_recurring_addon_subscriptions_team_id_idx" ON "billing_recurring_addon_subscriptions"("team_id");

CREATE INDEX "billing_recurring_addon_subscriptions_subscribing_user_idx" ON "billing_recurring_addon_subscriptions"("subscribing_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_subscriptions_account_id_stripe_sub_key" ON "billing_recurring_addon_subscriptions"("account_id", "stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_recurring_addon_subscriptions_account_id_stripe_ite_key" ON "billing_recurring_addon_subscriptions"("account_id", "stripe_item_id");

CREATE UNIQUE INDEX "billing_recurring_addon_subscriptions_account_invoice_key" ON "billing_recurring_addon_subscriptions"("account_id", "initial_invoice_id");

CREATE UNIQUE INDEX "billing_recurring_addon_subscriptions_activation_event_key" ON "billing_recurring_addon_subscriptions"("activation_webhook_event_id");

CREATE UNIQUE INDEX "billing_recurring_addon_cancel_intents_token_digest_key"
  ON "billing_recurring_addon_cancellation_intents"("token_digest");

CREATE UNIQUE INDEX "billing_recurring_addon_cancel_intents_app_idempotency_key"
  ON "billing_recurring_addon_cancellation_intents"("app_key_id", "idempotency_key");

CREATE INDEX "billing_recurring_addon_cancel_intents_subscription_state_idx"
  ON "billing_recurring_addon_cancellation_intents"("subscription_id", "state", "expires_at");

CREATE INDEX "billing_recurring_addon_cancel_intents_subject_idx"
  ON "billing_recurring_addon_cancellation_intents"("org_id", "requested_team_id", "requested_by_user_id");

CREATE INDEX "billing_recurring_addon_cancel_intents_subscriber_idx"
  ON "billing_recurring_addon_cancellation_intents"("subscribing_user_id");

CREATE UNIQUE INDEX "billing_recurring_addon_cancel_intents_one_unresolved"
  ON "billing_recurring_addon_cancellation_intents"("subscription_id")
  WHERE "state" IN ('AVAILABLE', 'PROCESSING');

-- AddForeignKey
ALTER TABLE "billing_credit_funding_policies" ADD CONSTRAINT "billing_credit_funding_policies_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_offers" ADD CONSTRAINT "billing_credit_top_up_offers_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_offers" ADD CONSTRAINT "billing_credit_top_up_offers_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "billing_credit_funding_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_options" ADD CONSTRAINT "billing_credit_auto_top_up_options_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "billing_credit_funding_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_options" ADD CONSTRAINT "billing_credit_auto_top_up_options_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_options" ADD CONSTRAINT "billing_credit_auto_top_up_options_refill_offer_id_fkey" FOREIGN KEY ("refill_offer_id") REFERENCES "billing_credit_top_up_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_catalogs" ADD CONSTRAINT "billing_credit_top_up_catalogs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_policy_id_fkey" FOREIGN KEY ("auto_top_up_policy_id") REFERENCES "billing_credit_funding_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_service_id_fkey" FOREIGN KEY ("auto_top_up_service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_app_key_id_fkey" FOREIGN KEY ("auto_top_up_app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_consent_revision_fkey" FOREIGN KEY ("auto_top_up_consent_revision_id") REFERENCES "billing_credit_auto_top_up_consent_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_option_id_fkey" FOREIGN KEY ("auto_top_up_option_id") REFERENCES "billing_credit_auto_top_up_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_refill_offer_id_fkey" FOREIGN KEY ("auto_top_up_refill_offer_id") REFERENCES "billing_credit_top_up_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_auto_top_up_consented_by_user_id_fkey" FOREIGN KEY ("auto_top_up_consented_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_attributed_user_id_fkey" FOREIGN KEY ("attributed_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_admin_adjustments" ADD CONSTRAINT "billing_credit_admin_adjustments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_admin_adjustments" ADD CONSTRAINT "billing_credit_admin_adjustments_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_admin_adjustments" ADD CONSTRAINT "billing_credit_admin_adjustments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_admin_adjustments" ADD CONSTRAINT "billing_credit_admin_adjustments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_admin_adjustments" ADD CONSTRAINT "billing_credit_admin_adjustments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The admin intent and its append-only entry are inserted in one transaction.
ALTER TABLE "billing_credit_admin_adjustments" ADD CONSTRAINT "billing_credit_admin_adjustments_credit_entry_id_fkey" FOREIGN KEY ("credit_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_original_entry_id_fkey" FOREIGN KEY ("original_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "billing_stripe_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The verified Stripe evidence and resulting debit commit atomically.
ALTER TABLE "billing_credit_payment_adjustments" ADD CONSTRAINT "billing_credit_payment_adjustments_credit_entry_id_fkey" FOREIGN KEY ("credit_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "billing_credit_portfolio_snapshots" ADD CONSTRAINT "billing_credit_portfolio_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_portfolio_snapshots" ADD CONSTRAINT "billing_credit_portfolio_snapshots_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_portfolio_snapshots" ADD CONSTRAINT "billing_credit_portfolio_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_portfolio_snapshots" ADD CONSTRAINT "billing_credit_portfolio_snapshots_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_portfolio_snapshots" ADD CONSTRAINT "billing_credit_portfolio_snapshots_perspective_service_fkey" FOREIGN KEY ("perspective_service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "billing_credit_top_up_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_credit_top_up_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_credit_entry_id_fkey" FOREIGN KEY ("credit_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_credit_top_up_checkouts" ADD CONSTRAINT "billing_credit_top_up_checkouts_completion_event_fkey" FOREIGN KEY ("completion_webhook_event_id") REFERENCES "billing_stripe_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "billing_credit_funding_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "billing_credit_auto_top_up_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_refill_offer_id_fkey" FOREIGN KEY ("refill_offer_id") REFERENCES "billing_credit_top_up_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_credit_setup_checkouts" ADD CONSTRAINT "billing_credit_setup_checkouts_completion_event_fkey" FOREIGN KEY ("completion_webhook_event_id") REFERENCES "billing_stripe_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "billing_credit_funding_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "billing_credit_auto_top_up_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_refill_offer_id_fkey" FOREIGN KEY ("refill_offer_id") REFERENCES "billing_credit_top_up_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_setup_checkout_id_fkey" FOREIGN KEY ("setup_checkout_id") REFERENCES "billing_credit_setup_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ADD CONSTRAINT "billing_credit_consent_revisions_consented_by_user_id_fkey" FOREIGN KEY ("consented_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "billing_credit_top_up_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_attributed_user_id_fkey" FOREIGN KEY ("attributed_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "billing_credit_auto_top_up_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_credit_top_up_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_trigger_entry_id_fkey" FOREIGN KEY ("trigger_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_consent_revision_id_fkey" FOREIGN KEY ("consent_revision_id") REFERENCES "billing_credit_auto_top_up_consent_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_credit_entry_id_fkey" FOREIGN KEY ("credit_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_credit_auto_top_up_attempts" ADD CONSTRAINT "billing_credit_auto_top_up_attempts_success_event_fkey" FOREIGN KEY ("success_webhook_event_id") REFERENCES "billing_stripe_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlements" ADD CONSTRAINT "billing_credit_usage_settlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlements" ADD CONSTRAINT "billing_credit_usage_settlements_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlements" ADD CONSTRAINT "billing_credit_usage_settlements_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "billing_stripe_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlements" ADD CONSTRAINT "billing_credit_usage_settlements_tariff_id_fkey" FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlements" ADD CONSTRAINT "billing_credit_usage_settlements_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlements" ADD CONSTRAINT "billing_credit_usage_settlements_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "billing_credit_usage_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_credit_account_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_adjustments_portfolio_snapshot_fkey" FOREIGN KEY ("portfolio_snapshot_id") REFERENCES "billing_credit_portfolio_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_settlement_adjustments" ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_credit_entry_i_fkey" FOREIGN KEY ("credit_entry_id") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_allocations" ADD CONSTRAINT "billing_credit_usage_allocations_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "billing_credit_usage_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_allocations" ADD CONSTRAINT "billing_credit_usage_allocations_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "billing_credit_usage_settlement_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_allocations" ADD CONSTRAINT "billing_credit_usage_allocations_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_allocations" ADD CONSTRAINT "billing_credit_usage_allocations_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_usage_allocations" ADD CONSTRAINT "billing_credit_usage_allocations_attributed_user_id_fkey" FOREIGN KEY ("attributed_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_invoice_lines" ADD CONSTRAINT "billing_credit_invoice_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_invoice_lines" ADD CONSTRAINT "billing_credit_invoice_lines_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "billing_credit_usage_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_invoice_lines" ADD CONSTRAINT "billing_credit_invoice_lines_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "billing_stripe_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_invoice_lines" ADD CONSTRAINT "billing_credit_invoice_lines_last_adjustment_id_fkey" FOREIGN KEY ("last_adjustment_id") REFERENCES "billing_credit_usage_settlement_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_offers" ADD CONSTRAINT "billing_recurring_addon_offers_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_feature_policies" ADD CONSTRAINT "billing_recurring_addon_feature_policies_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_feature_policies" ADD CONSTRAINT "billing_recurring_addon_feature_policies_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_recurring_addon_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_feature_policies" ADD CONSTRAINT "billing_recurring_addon_feature_policies_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_feature_policies" ADD CONSTRAINT "billing_recurring_addon_feature_policies_app_id_feature_fl_fkey" FOREIGN KEY ("app_id", "feature_flag_key") REFERENCES "feature_flag_definitions"("app_id", "key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_catalogs" ADD CONSTRAINT "billing_recurring_addon_catalogs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_catalogs" ADD CONSTRAINT "billing_recurring_addon_catalogs_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_catalogs" ADD CONSTRAINT "billing_recurring_addon_catalogs_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_recurring_addon_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "billing_recurring_addon_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_recurring_addon_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_requested_team_id_fkey" FOREIGN KEY ("requested_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_subscribing_user_fkey" FOREIGN KEY ("subscribing_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_checkouts" ADD CONSTRAINT "billing_recurring_addon_checkouts_completion_event_fkey" FOREIGN KEY ("completion_webhook_event_id") REFERENCES "billing_stripe_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "billing_recurring_addon_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "billing_recurring_addon_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_recurring_addon_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_subscribing_user_fkey" FOREIGN KEY ("subscribing_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_subscriptions" ADD CONSTRAINT "billing_recurring_addon_subscriptions_activation_event_fkey" FOREIGN KEY ("activation_webhook_event_id") REFERENCES "billing_stripe_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "billing_recurring_addon_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "billing_recurring_addon_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_requested_team_id_fkey" FOREIGN KEY ("requested_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_subscribing_user_id_fkey" FOREIGN KEY ("subscribing_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_recurring_addon_cancellation_intents" ADD CONSTRAINT "billing_recurring_addon_cancel_intents_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Credits are fixed at 1,000 credits per US$1. One cent therefore funds exactly
-- 10 credits, or 10,000,000 microcredits. Non-USD funding and settlement fail closed.
ALTER TABLE "billing_credit_funding_policies"
  ADD CONSTRAINT "billing_credit_funding_policies_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "billing_credit_funding_policies_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "billing_credit_funding_policies_consent_check"
    CHECK (length(btrim("automatic_consent_version")) > 0),
  ADD CONSTRAINT "billing_credit_funding_policies_auto_gate_check"
    CHECK (NOT "automatic_top_up_enabled" OR "top_up_enabled"),
  ADD CONSTRAINT "billing_credit_funding_policies_deactivation_check" CHECK (
    ("active" AND "deactivated_at" IS NULL)
    OR (NOT "active" AND "deactivated_at" IS NOT NULL)
  );

ALTER TABLE "billing_credit_top_up_offers"
  ADD CONSTRAINT "billing_credit_top_up_offers_version_check"
    CHECK ("version" > 0 AND "catalog_version" > 0),
  ADD CONSTRAINT "billing_credit_top_up_offers_catalog_key_check"
    CHECK ("catalog_key" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  ADD CONSTRAINT "billing_credit_top_up_offers_fixed_conversion_check" CHECK (
    "payment_amount_minor" > 0
    AND "credits_received_microcredits"::numeric
      = "payment_amount_minor"::numeric * 10000000
  ),
  ADD CONSTRAINT "billing_credit_top_up_offers_deactivation_check" CHECK (
    ("active" AND "deactivated_at" IS NULL)
    OR (NOT "active" AND "deactivated_at" IS NOT NULL)
  );

ALTER TABLE "billing_credit_auto_top_up_options"
  ADD CONSTRAINT "billing_credit_auto_top_up_options_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "billing_credit_auto_top_up_options_values_check" CHECK (
    "threshold_microcredits" >= 0 AND "monthly_charge_cap_minor" > 0
  ),
  ADD CONSTRAINT "billing_credit_auto_top_up_options_deactivation_check" CHECK (
    ("active" AND "deactivated_at" IS NULL)
    OR (NOT "active" AND "deactivated_at" IS NOT NULL)
  );

ALTER TABLE "billing_credit_top_up_catalogs"
  ADD CONSTRAINT "billing_credit_top_up_catalogs_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "billing_credit_top_up_catalogs_key_check"
    CHECK ("key" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  ADD CONSTRAINT "billing_credit_top_up_catalogs_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "billing_credit_top_up_catalogs_fixed_conversion_check" CHECK (
    "payment_amount_minor" > 0
    AND "credits_received_microcredits"::numeric
      = "payment_amount_minor"::numeric * 10000000
  ),
  ADD CONSTRAINT "billing_credit_top_up_catalogs_lookup_key_check"
    CHECK (length(btrim("stripe_lookup_key")) > 0),
  ADD CONSTRAINT "billing_credit_top_up_catalogs_stripe_binding_check" CHECK (
    ("stripe_product_id" IS NULL AND "stripe_price_id" IS NULL)
    OR ("stripe_product_id" IS NOT NULL AND "stripe_price_id" IS NOT NULL)
  );

ALTER TABLE "billing_credit_accounts"
  ADD CONSTRAINT "billing_credit_accounts_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "billing_credit_accounts_auto_values_check" CHECK (
    "auto_top_up_threshold_microcredits" IS NULL
    OR "auto_top_up_threshold_microcredits" >= 0
  ),
  ADD CONSTRAINT "billing_credit_accounts_auto_cap_check" CHECK (
    "auto_top_up_monthly_charge_cap_minor" IS NULL
    OR "auto_top_up_monthly_charge_cap_minor" > 0
  ),
  ADD CONSTRAINT "billing_credit_accounts_auto_configuration_check" CHECK (
    (
      "auto_top_up_state" = 'DISABLED'
      AND "auto_top_up_policy_id" IS NULL
      AND "auto_top_up_service_id" IS NULL
      AND "auto_top_up_app_key_id" IS NULL
      AND "auto_top_up_consent_revision_id" IS NULL
      AND "auto_top_up_option_id" IS NULL
      AND "auto_top_up_threshold_microcredits" IS NULL
      AND "auto_top_up_refill_offer_id" IS NULL
      AND "auto_top_up_monthly_charge_cap_minor" IS NULL
      AND "auto_top_up_consent_version" IS NULL
      AND "auto_top_up_consented_at" IS NULL
      AND "auto_top_up_consented_by_user_id" IS NULL
    )
    OR (
      "auto_top_up_state" <> 'DISABLED'
      AND "auto_top_up_policy_id" IS NOT NULL
      AND "auto_top_up_service_id" IS NOT NULL
      AND "auto_top_up_app_key_id" IS NOT NULL
      AND "auto_top_up_consent_revision_id" IS NOT NULL
      AND "auto_top_up_option_id" IS NOT NULL
      AND "auto_top_up_threshold_microcredits" IS NOT NULL
      AND "auto_top_up_refill_offer_id" IS NOT NULL
      AND "auto_top_up_monthly_charge_cap_minor" IS NOT NULL
      AND "auto_top_up_consent_version" IS NOT NULL
      AND "auto_top_up_consented_at" IS NOT NULL
      AND "auto_top_up_consented_by_user_id" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "billing_credit_accounts_active_auto_top_up_check" CHECK (
    "auto_top_up_state" = 'DISABLED'
    OR (
      "auto_top_up_option_id" IS NOT NULL
      AND "auto_top_up_consent_revision_id" IS NOT NULL
      AND "stripe_payment_method_id" IS NOT NULL
    )
  );

ALTER TABLE "billing_credit_entries"
  ADD CONSTRAINT "billing_credit_entries_amount_check" CHECK ("amount_microcredits" > 0),
  ADD CONSTRAINT "billing_credit_entries_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "billing_credit_entries_source_check" CHECK (
    length(btrim("source_type")) > 0 AND length(btrim("source_id")) > 0
  ),
  ADD CONSTRAINT "billing_credit_entries_provenance_check" CHECK (
    (
      "kind" = 'ADJUSTMENT'
      AND "service_id" IS NULL
      AND "app_key_id" IS NULL
      AND "attributed_user_id" IS NULL
      AND "source_type" = 'credit_admin_adjustment'
    )
    OR (
      "kind" <> 'ADJUSTMENT'
      AND "service_id" IS NOT NULL
      AND "app_key_id" IS NOT NULL
      AND "source_type" <> 'credit_admin_adjustment'
    )
  ),
  ADD CONSTRAINT "billing_credit_entries_kind_check" CHECK (
    ("kind" IN ('TOP_UP', 'AUTOMATIC_TOP_UP') AND "direction" = 'CREDIT' AND "attributed_user_id" IS NOT NULL)
    OR ("kind" = 'USAGE_SETTLEMENT' AND "direction" = 'DEBIT')
    OR ("kind" = 'USAGE_SETTLEMENT_CORRECTION')
    OR (
      "kind" IN ('REFUND', 'DISPUTE')
      AND "direction" = 'DEBIT'
      AND "reverses_entry_id" IS NOT NULL
      AND "source_type" = 'credit_payment_adjustment'
    )
    OR ("kind" = 'ADJUSTMENT')
  );

ALTER TABLE "billing_credit_admin_adjustments"
  ADD CONSTRAINT "billing_credit_admin_adjustments_values_check" CHECK (
    "signed_amount_microcredits" <> 0
    AND "signed_amount_microcredits" > -9223372036854775808
    AND "signed_amount_microcredits" % 10 = 0
    AND length(btrim("reason")) > 0
    AND length(btrim("idempotency_key")) > 0
    AND length(btrim("created_by_email")) > 0
    AND length(btrim("created_by_admin_domain")) > 0
  );

ALTER TABLE "billing_stripe_webhook_events"
  ADD CONSTRAINT "billing_stripe_webhook_events_verified_facts_check" CHECK (
    ("amount_minor" IS NULL AND "currency" IS NULL)
    OR ("amount_minor" >= 0 AND "currency" = 'USD')
  );

ALTER TABLE "billing_credit_payment_adjustments"
  ADD CONSTRAINT "billing_credit_payment_adjustments_values_check" CHECK (
    "currency" = 'USD'
    AND "amount_minor" > 0
    AND "amount_microcredits"::numeric
      = "amount_minor"::numeric * 10000000
    AND length(btrim("idempotency_key")) > 0
    AND "stripe_payment_intent_id" ~ '^pi_[A-Za-z0-9_-]+$'
    AND "stripe_charge_id" ~ '^ch_[A-Za-z0-9_-]+$'
    AND (
      ("kind" = 'REFUND' AND "stripe_object_id" ~ '^re_[A-Za-z0-9_-]+$')
      OR ("kind" = 'DISPUTE' AND "stripe_object_id" ~ '^dp_[A-Za-z0-9_-]+$')
    )
  );

ALTER TABLE "billing_credit_portfolio_snapshots"
  ADD CONSTRAINT "billing_credit_portfolio_snapshots_contract_check" CHECK (
    "contract" = 'metering-portfolio-v1'
    AND "group_by" = 'user'
    AND "ledger_snapshot_id" = "ledger_snapshot_cursor"
    AND "ledger_snapshot_id" ~ '^mup_[A-Za-z0-9_-]+$'
    AND "sha256" ~ '^[a-f0-9]{64}$'
    AND "billing_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  );

ALTER TABLE "billing_credit_top_up_checkouts"
  ADD CONSTRAINT "billing_credit_top_up_checkouts_fixed_conversion_check" CHECK (
    "currency" = 'USD'
    AND "payment_amount_minor" > 0
    AND "credits_received_microcredits"::numeric
      = "payment_amount_minor"::numeric * 10000000
  ),
  ADD CONSTRAINT "billing_credit_top_up_checkouts_digest_check" CHECK (
    "success_url_digest" ~ '^[a-f0-9]{64}$'
    AND "cancel_url_digest" ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT "billing_credit_top_up_checkouts_completion_check" CHECK (
    (
      "status" = 'COMPLETE'
      AND "stripe_checkout_session_id" IS NOT NULL
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "completion_webhook_event_id" IS NOT NULL
      AND "credit_entry_id" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "status" <> 'COMPLETE'
      AND "credit_entry_id" IS NULL
      AND "completed_at" IS NULL
      AND "completion_webhook_event_id" IS NULL
    )
  );

ALTER TABLE "billing_credit_setup_checkouts"
  ADD CONSTRAINT "billing_credit_setup_checkouts_values_check" CHECK (
    "threshold_microcredits" >= 0
    AND "refill_payment_amount_minor" > 0
    AND "refill_credits_microcredits"::numeric
      = "refill_payment_amount_minor"::numeric * 10000000
    AND "monthly_charge_cap_minor" >= "refill_payment_amount_minor"
  ),
  ADD CONSTRAINT "billing_credit_setup_checkouts_digest_check" CHECK (
    "success_url_digest" ~ '^[a-f0-9]{64}$'
    AND "cancel_url_digest" ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT "billing_credit_setup_checkouts_completion_check" CHECK (
    (
      "status" = 'COMPLETE'
      AND "stripe_checkout_session_id" IS NOT NULL
      AND "stripe_setup_intent_id" IS NOT NULL
      AND "stripe_payment_method_id" IS NOT NULL
      AND "completion_webhook_event_id" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "status" <> 'COMPLETE'
      AND "completed_at" IS NULL
      AND "completion_webhook_event_id" IS NULL
    )
  );

ALTER TABLE "billing_credit_auto_top_up_consent_revisions"
  ADD CONSTRAINT "billing_credit_consent_revisions_values_check" CHECK (
    length(btrim("actor_jti")) > 0
    AND length(btrim("consent_version")) > 0
    AND length(btrim("stripe_payment_method_id")) > 0
    AND "threshold_microcredits" >= 0
    AND "threshold_microcredits" % 10 = 0
    AND "refill_payment_amount_minor" > 0
    AND "refill_credits_microcredits"::numeric
      = "refill_payment_amount_minor"::numeric * 10000000
    AND "monthly_charge_cap_minor" >= "refill_payment_amount_minor"
  ),
  ADD CONSTRAINT "billing_credit_consent_revisions_source_check" CHECK (
    ("source" = 'SETUP_CHECKOUT' AND "setup_checkout_id" IS NOT NULL)
    OR ("source" = 'CUSTOMER_UPDATE' AND "setup_checkout_id" IS NULL)
  );

ALTER TABLE "billing_credit_auto_top_up_attempts"
  ADD CONSTRAINT "billing_credit_auto_top_up_attempts_month_check"
    CHECK ("billing_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "billing_credit_auto_top_up_attempts_values_check" CHECK (
    "threshold_microcredits" >= 0
    AND "monthly_charge_cap_minor" > 0
    AND "charged_this_month_before_minor" >= 0
    AND "payment_amount_minor" > 0
    AND "credits_received_microcredits"::numeric
      = "payment_amount_minor"::numeric * 10000000
    AND "charged_this_month_before_minor" + "payment_amount_minor"
      <= "monthly_charge_cap_minor"
  ),
  ADD CONSTRAINT "billing_credit_auto_top_up_attempts_completion_check" CHECK (
    (
      "status" = 'SUCCEEDED'
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "success_webhook_event_id" IS NOT NULL
      AND "credit_entry_id" IS NOT NULL
      AND "resolved_at" IS NOT NULL
    )
    OR (
      "status" IN ('FAILED', 'CANCELED')
      AND "credit_entry_id" IS NULL
      AND "success_webhook_event_id" IS NULL
      AND "resolved_at" IS NOT NULL
    )
    OR (
      "status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
      AND "credit_entry_id" IS NULL
      AND "success_webhook_event_id" IS NULL
      AND "resolved_at" IS NULL
    )
  );

ALTER TABLE "billing_credit_usage_settlements"
  ADD CONSTRAINT "billing_credit_usage_settlements_month_check"
    CHECK ("billing_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "billing_credit_usage_settlements_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "billing_credit_usage_settlements_totals_check" CHECK (
    "cumulative_rated_usage_amount_micro_minor" >= 0
    AND "cumulative_credits_consumed_microcredits" >= 0
    AND "cumulative_remaining_usage_amount_micro_minor" >= 0
    AND "cumulative_remaining_usage_amount_micro_minor"::numeric * 10
      = "cumulative_rated_usage_amount_micro_minor"::numeric * 10
        - "cumulative_credits_consumed_microcredits"::numeric
  );

ALTER TABLE "billing_credit_usage_settlement_adjustments"
  ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_sequence_check"
    CHECK ("sequence" > 0),
  ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_delta_check" CHECK (
    (
      "delta_rated_usage_amount_micro_minor" <> 0
      OR "delta_credits_consumed_microcredits" <> 0
      OR "delta_remaining_usage_amount_micro_minor" <> 0
    )
    AND "delta_remaining_usage_amount_micro_minor"::numeric * 10
      = "delta_rated_usage_amount_micro_minor"::numeric * 10
        - "delta_credits_consumed_microcredits"::numeric
    AND (
      ("delta_credits_consumed_microcredits" = 0 AND "credit_entry_id" IS NULL)
      OR ("delta_credits_consumed_microcredits" <> 0 AND "credit_entry_id" IS NOT NULL)
    )
  ),
  ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_totals_check" CHECK (
    "cumulative_rated_usage_amount_micro_minor" >= 0
    AND "cumulative_credits_consumed_microcredits" >= 0
    AND "cumulative_remaining_usage_amount_micro_minor" >= 0
    AND "cumulative_remaining_usage_amount_micro_minor"::numeric * 10
      = "cumulative_rated_usage_amount_micro_minor"::numeric * 10
        - "cumulative_credits_consumed_microcredits"::numeric
  );

ALTER TABLE "billing_credit_usage_allocations"
  ADD CONSTRAINT "billing_credit_usage_allocations_delta_check" CHECK (
    (
      "delta_rated_usage_amount_micro_minor" <> 0
      OR "delta_credits_consumed_microcredits" <> 0
      OR "delta_remaining_usage_amount_micro_minor" <> 0
    )
    AND "delta_remaining_usage_amount_micro_minor"::numeric * 10
      = "delta_rated_usage_amount_micro_minor"::numeric * 10
        - "delta_credits_consumed_microcredits"::numeric
  ),
  ADD CONSTRAINT "billing_credit_usage_allocations_totals_check" CHECK (
    "cumulative_rated_usage_amount_micro_minor" >= 0
    AND "cumulative_credits_consumed_microcredits" >= 0
    AND "cumulative_remaining_usage_amount_micro_minor" >= 0
    AND "cumulative_remaining_usage_amount_micro_minor"::numeric * 10
      = "cumulative_rated_usage_amount_micro_minor"::numeric * 10
        - "cumulative_credits_consumed_microcredits"::numeric
  );

ALTER TABLE "billing_credit_invoice_lines"
  ADD CONSTRAINT "billing_credit_invoice_lines_exact_projection_check" CHECK (
    "cumulative_credits_consumed_microcredits" >= 0
    AND "stripe_unit_amount_decimal" = '-0.000001'
    AND "stripe_quantity" >= 0
    AND "stripe_quantity"::numeric * 10
      = "cumulative_credits_consumed_microcredits"::numeric
  ),
  ADD CONSTRAINT "billing_credit_invoice_lines_applied_check" CHECK (
    "status" <> 'APPLIED' OR "stripe_invoice_item_id" IS NOT NULL
  );

ALTER TABLE "billing_recurring_addon_offers"
  ADD CONSTRAINT "billing_recurring_addon_offers_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "billing_recurring_addon_offers_amount_check" CHECK ("monthly_amount_minor" > 0),
  ADD CONSTRAINT "billing_recurring_addon_offers_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "billing_recurring_addon_offers_deactivation_check" CHECK (
    ("active" AND "deactivated_at" IS NULL)
    OR (NOT "active" AND "deactivated_at" IS NOT NULL)
  );

ALTER TABLE "billing_recurring_addon_catalogs"
  ADD CONSTRAINT "billing_recurring_addon_catalogs_amount_check" CHECK ("monthly_amount_minor" > 0),
  ADD CONSTRAINT "billing_recurring_addon_catalogs_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "billing_recurring_addon_catalogs_lookup_key_check"
    CHECK (length(btrim("stripe_lookup_key")) > 0),
  ADD CONSTRAINT "billing_recurring_addon_catalogs_stripe_binding_check" CHECK (
    ("stripe_product_id" IS NULL AND "stripe_price_id" IS NULL)
    OR ("stripe_product_id" IS NOT NULL AND "stripe_price_id" IS NOT NULL)
  );

ALTER TABLE "billing_recurring_addon_checkouts"
  ADD CONSTRAINT "billing_recurring_addon_checkouts_scope_check" CHECK (
    (
      "scope" = 'ORGANISATION'
      AND "team_id" IS NULL
      AND "subscribing_user_id" IS NULL
      AND "scope_key" = "org_id"
    )
    OR (
      "scope" = 'TEAM'
      AND "team_id" IS NOT NULL
      AND "requested_team_id" = "team_id"
      AND "subscribing_user_id" IS NULL
      AND "scope_key" = "org_id" || ':' || "team_id"
    )
    OR (
      "scope" = 'SUBSCRIBING_USER'
      AND "team_id" IS NOT NULL
      AND "requested_team_id" = "team_id"
      AND "subscribing_user_id" IS NOT NULL
      AND "scope_key" = "org_id" || ':' || "team_id" || ':' || "subscribing_user_id"
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_checkouts_offer_key_check"
    CHECK (length(btrim("offer_key")) > 0),
  ADD CONSTRAINT "billing_recurring_addon_checkouts_digest_check" CHECK (
    "success_url_digest" ~ '^[a-f0-9]{64}$'
    AND "cancel_url_digest" ~ '^[a-f0-9]{64}$'
    AND "subject_fingerprint" ~ '^[a-f0-9]{64}$'
    AND length(btrim("actor_jti")) > 0
  ),
  ADD CONSTRAINT "billing_recurring_addon_checkouts_completion_check" CHECK (
    (
      "status" = 'COMPLETE'
      AND "stripe_checkout_session_id" IS NOT NULL
      AND "stripe_subscription_id" IS NOT NULL
      AND "completion_webhook_event_id" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "status" <> 'COMPLETE'
      AND "completed_at" IS NULL
      AND "completion_webhook_event_id" IS NULL
    )
  );

ALTER TABLE "billing_recurring_addon_subscriptions"
  ADD CONSTRAINT "billing_recurring_addon_subscriptions_scope_check" CHECK (
    (
      "scope" = 'ORGANISATION'
      AND "team_id" IS NULL
      AND "subscribing_user_id" IS NULL
      AND "scope_key" = "org_id"
    )
    OR (
      "scope" = 'TEAM'
      AND "team_id" IS NOT NULL
      AND "subscribing_user_id" IS NULL
      AND "scope_key" = "org_id" || ':' || "team_id"
    )
    OR (
      "scope" = 'SUBSCRIBING_USER'
      AND "team_id" IS NOT NULL
      AND "subscribing_user_id" IS NOT NULL
      AND "scope_key" = "org_id" || ':' || "team_id" || ':' || "subscribing_user_id"
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_subscriptions_offer_key_check"
    CHECK (length(btrim("offer_key")) > 0),
  ADD CONSTRAINT "billing_recurring_addon_subscriptions_status_check" CHECK (
    "status" IN (
      'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_subscriptions_paid_entitlement_check" CHECK (
    "entitlement_activated_at" IS NULL
    OR (
      "initial_invoice_paid_at" IS NOT NULL
      AND "initial_invoice_id" IS NOT NULL
      AND "activation_webhook_event_id" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_subscriptions_entitlement_period_check" CHECK (
    "entitlement_deactivated_at" IS NULL
    OR (
      "entitlement_activated_at" IS NOT NULL
      AND "entitlement_deactivated_at" >= "entitlement_activated_at"
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_subscriptions_terminal_entitlement_check" CHECK (
    (
      "status" NOT IN ('canceled', 'incomplete_expired')
      OR "entitlement_activated_at" IS NULL
      OR "entitlement_deactivated_at" IS NOT NULL
    )
    AND (
      "entitlement_deactivated_at" IS NULL
      OR "status" NOT IN ('active', 'trialing')
    )
  );

ALTER TABLE "billing_recurring_addon_cancellation_intents"
  ADD CONSTRAINT "billing_recurring_addon_cancel_intents_scope_check" CHECK (
    (
      "scope" = 'ORGANISATION'
      AND "team_id" IS NULL
      AND "subscribing_user_id" IS NULL
      AND "scope_key" = "org_id"
    )
    OR (
      "scope" = 'TEAM'
      AND "team_id" IS NOT NULL
      AND "requested_team_id" = "team_id"
      AND "subscribing_user_id" IS NULL
      AND "scope_key" = "org_id" || ':' || "team_id"
    )
    OR (
      "scope" = 'SUBSCRIBING_USER'
      AND "team_id" IS NOT NULL
      AND "requested_team_id" = "team_id"
      AND "subscribing_user_id" IS NOT NULL
      AND "scope_key" = "org_id" || ':' || "team_id" || ':' || "subscribing_user_id"
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_cancel_intents_digest_check" CHECK (
    "token_digest" ~ '^[a-f0-9]{64}$'
    AND "subject_fingerprint" ~ '^[a-f0-9]{64}$'
    AND (
      "confirmation_request_digest" IS NULL
      OR "confirmation_request_digest" ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT "billing_recurring_addon_cancel_intents_choice_check"
    CHECK ("choice" = 'cancel_addon'),
  ADD CONSTRAINT "billing_recurring_addon_cancel_intents_actor_check" CHECK (
    length(btrim("actor_jti")) > 0
    AND length(btrim("idempotency_key")) >= 16
  ),
  ADD CONSTRAINT "billing_recurring_addon_cancel_intents_expiry_check"
    CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "billing_recurring_addon_cancel_intents_state_check" CHECK (
    (
      "state" = 'AVAILABLE'
      AND "confirmation_request_digest" IS NULL
      AND "result" IS NULL
      AND "consumed_at" IS NULL
    )
    OR (
      "state" = 'PROCESSING'
      AND "confirmation_request_digest" IS NOT NULL
      AND "result" IS NULL
      AND "consumed_at" IS NULL
    )
    OR (
      "state" = 'COMPLETED'
      AND "confirmation_request_digest" IS NOT NULL
      AND "result" IS NOT NULL
      AND "consumed_at" IS NOT NULL
    )
    OR (
      "state" = 'EXPIRED'
      AND "confirmation_request_digest" IS NULL
      AND "result" IS NULL
      AND "consumed_at" IS NULL
    )
  );

CREATE UNIQUE INDEX "billing_credit_funding_policies_one_active_version"
  ON "billing_credit_funding_policies"("service_id") WHERE "active";
CREATE UNIQUE INDEX "billing_credit_top_up_offers_one_active_key"
  ON "billing_credit_top_up_offers"("policy_id", "key") WHERE "active";
CREATE UNIQUE INDEX "billing_credit_auto_top_up_options_one_active_key"
  ON "billing_credit_auto_top_up_options"("policy_id", "key") WHERE "active";
CREATE UNIQUE INDEX "billing_credit_top_up_checkouts_one_unresolved_account"
  ON "billing_credit_top_up_checkouts"("credit_account_id")
  WHERE "status" IN ('CREATING', 'OPEN', 'NEEDS_REVIEW');
CREATE UNIQUE INDEX "billing_credit_setup_checkouts_one_unresolved_account"
  ON "billing_credit_setup_checkouts"("credit_account_id")
  WHERE "status" IN ('CREATING', 'OPEN', 'NEEDS_REVIEW');
CREATE UNIQUE INDEX "billing_credit_auto_top_up_attempts_one_unresolved_account"
  ON "billing_credit_auto_top_up_attempts"("credit_account_id")
  WHERE "status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW');
CREATE UNIQUE INDEX "billing_recurring_addon_offers_one_active_version"
  ON "billing_recurring_addon_offers"("service_id", "key") WHERE "active";
CREATE UNIQUE INDEX "billing_recurring_addon_checkouts_one_unresolved_scope"
  ON "billing_recurring_addon_checkouts"("account_id", "service_id", "offer_key", "scope", "scope_key")
  WHERE "status" IN ('CREATING', 'OPEN', 'NEEDS_REVIEW');
CREATE UNIQUE INDEX "billing_recurring_addon_subscriptions_one_live_scope"
  ON "billing_recurring_addon_subscriptions"("account_id", "service_id", "offer_key", "scope", "scope_key")
  WHERE "status" NOT IN ('canceled', 'incomplete_expired');

-- Versioned commercial terms may only transition between active/inactive. Their
-- terms remain immutable, while Stripe resource bindings may be synchronized.
CREATE FUNCTION "billing_guard_versioned_terms"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is immutable; deactivate it instead', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'active' - 'deactivated_at' - 'updated_at')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'active' - 'deactivated_at' - 'updated_at') THEN
    RAISE EXCEPTION '% terms are immutable; create a new version', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_funding_policies_versioned_terms"
  BEFORE UPDATE OR DELETE ON "billing_credit_funding_policies"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_versioned_terms"();
CREATE TRIGGER "billing_credit_top_up_offers_versioned_terms"
  BEFORE UPDATE OR DELETE ON "billing_credit_top_up_offers"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_versioned_terms"();
CREATE TRIGGER "billing_credit_auto_top_up_options_versioned_terms"
  BEFORE UPDATE OR DELETE ON "billing_credit_auto_top_up_options"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_versioned_terms"();
CREATE TRIGGER "billing_recurring_addon_offers_versioned_terms"
  BEFORE UPDATE OR DELETE ON "billing_recurring_addon_offers"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_versioned_terms"();

CREATE FUNCTION "billing_guard_stripe_catalog_terms"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'stripe_product_id' - 'stripe_price_id' - 'updated_at')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'stripe_product_id' - 'stripe_price_id' - 'updated_at') THEN
    RAISE EXCEPTION '% commercial terms are immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_top_up_catalogs_immutable_terms"
  BEFORE UPDATE OR DELETE ON "billing_credit_top_up_catalogs"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_stripe_catalog_terms"();
CREATE TRIGGER "billing_recurring_addon_catalogs_immutable_terms"
  BEFORE UPDATE OR DELETE ON "billing_recurring_addon_catalogs"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_stripe_catalog_terms"();

CREATE FUNCTION "billing_reject_immutable_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "billing_stripe_webhook_events_append_only"
  BEFORE UPDATE OR DELETE ON "billing_stripe_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();

CREATE TRIGGER "billing_credit_entries_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_entries"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();
CREATE TRIGGER "billing_credit_admin_adjustments_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_admin_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();
CREATE TRIGGER "billing_credit_payment_adjustments_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_payment_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();
CREATE TRIGGER "billing_credit_portfolio_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_portfolio_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();
CREATE TRIGGER "billing_credit_consent_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_auto_top_up_consent_revisions"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();
CREATE TRIGGER "billing_credit_usage_adjustments_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_usage_settlement_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();
CREATE TRIGGER "billing_credit_usage_allocations_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_usage_allocations"
  FOR EACH ROW EXECUTE FUNCTION "billing_reject_immutable_history"();

CREATE FUNCTION "billing_assert_credit_app_key_service"(
  expected_service_id TEXT,
  expected_app_key_id TEXT
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "billing_app_keys" AS key
    WHERE key."id" = expected_app_key_id
      AND key."service_id" = expected_service_id
      AND key."purpose" = 'CUSTOMER_LIFECYCLE'
  ) THEN
    RAISE EXCEPTION 'billing app key does not belong to the exact service'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "billing_assert_credit_app_key"(
  expected_service_id TEXT,
  expected_app_key_id TEXT
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "billing_app_keys" AS key
    WHERE key."id" = expected_app_key_id
      AND key."service_id" = expected_service_id
      AND key."purpose" = 'CUSTOMER_LIFECYCLE'
      AND key."revoked_at" IS NULL
      AND (key."expires_at" IS NULL OR key."expires_at" > CURRENT_TIMESTAMP)
  ) THEN
    RAISE EXCEPTION 'billing app key is not active for the exact service'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "billing_assert_credit_team_user"(
  expected_team_id TEXT,
  expected_user_id TEXT,
  require_active BOOLEAN
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "team_members" AS member
    WHERE member."team_id" = expected_team_id
      AND member."user_id" = expected_user_id
      AND (NOT require_active OR member."status" = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'billing user is not a member of the exact team'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "billing_assert_credit_team_manager"(
  expected_org_id TEXT,
  expected_team_id TEXT,
  expected_user_id TEXT
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "org_members" AS org_member
    JOIN "teams" AS team ON team."org_id" = org_member."org_id"
    JOIN "team_members" AS team_member
      ON team_member."team_id" = team."id"
     AND team_member."user_id" = org_member."user_id"
    WHERE org_member."org_id" = expected_org_id
      AND org_member."user_id" = expected_user_id
      AND org_member."status" = 'ACTIVE'
      AND team."id" = expected_team_id
      AND team_member."status" = 'ACTIVE'
      AND (
        org_member."role" IN ('owner', 'admin')
        OR team_member."team_role" IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1 FROM "organisations" AS organisation
          WHERE organisation."id" = expected_org_id
            AND organisation."owner_id" = expected_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'billing action requires an active exact-team manager'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "billing_credit_offer_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_row "billing_credit_funding_policies"%ROWTYPE;
BEGIN
  SELECT * INTO policy_row
  FROM "billing_credit_funding_policies"
  WHERE "id" = NEW."policy_id";
  IF NOT FOUND
     OR policy_row."service_id" <> NEW."service_id"
     OR policy_row."currency" <> 'USD' THEN
    RAISE EXCEPTION 'credit offer does not match its service funding policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_top_up_offers_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_top_up_offers"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_offer_coherence"();

CREATE FUNCTION "billing_credit_auto_option_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
BEGIN
  SELECT * INTO policy_row
  FROM "billing_credit_funding_policies"
  WHERE "id" = NEW."policy_id";
  SELECT * INTO offer_row
  FROM "billing_credit_top_up_offers"
  WHERE "id" = NEW."refill_offer_id";
  IF policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR offer_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR NOT offer_row."automatic_top_up_eligible"
     OR NEW."monthly_charge_cap_minor" < offer_row."payment_amount_minor" THEN
    RAISE EXCEPTION 'automatic top-up option does not match its policy and refill offer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_auto_top_up_options_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_auto_top_up_options"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_auto_option_coherence"();

CREATE FUNCTION "billing_credit_consent_revision_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  checkout_row "billing_credit_setup_checkouts"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id" FOR UPDATE;
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = NEW."policy_id";
  SELECT * INTO option_row FROM "billing_credit_auto_top_up_options"
    WHERE "id" = NEW."option_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."refill_offer_id";
  PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
  PERFORM "billing_assert_credit_team_manager"(
    NEW."org_id", NEW."team_id", NEW."consented_by_user_id"
  );
  IF credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR credit_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."active"
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
     OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
     OR option_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
     OR NOT option_row."active"
     OR offer_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."credits_received_microcredits" IS DISTINCT FROM NEW."refill_credits_microcredits"
     OR offer_row."payment_amount_minor" IS DISTINCT FROM NEW."refill_payment_amount_minor"
     OR NOT offer_row."active"
     OR NOT offer_row."automatic_top_up_eligible" THEN
    RAISE EXCEPTION 'automatic top-up consent revision does not match active exact terms'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."source" = 'SETUP_CHECKOUT' THEN
    SELECT * INTO checkout_row FROM "billing_credit_setup_checkouts"
      WHERE "id" = NEW."setup_checkout_id";
    IF checkout_row."status" IS DISTINCT FROM 'COMPLETE'
       OR checkout_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR checkout_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR checkout_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR checkout_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR checkout_row."policy_id" IS DISTINCT FROM NEW."policy_id"
       OR checkout_row."option_id" IS DISTINCT FROM NEW."option_id"
       OR checkout_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
       OR checkout_row."actor_jti" IS DISTINCT FROM NEW."actor_jti"
       OR checkout_row."requested_by_user_id" IS DISTINCT FROM NEW."consented_by_user_id"
       OR checkout_row."consent_version" IS DISTINCT FROM NEW."consent_version"
       OR checkout_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
       OR checkout_row."refill_credits_microcredits" IS DISTINCT FROM NEW."refill_credits_microcredits"
       OR checkout_row."refill_payment_amount_minor" IS DISTINCT FROM NEW."refill_payment_amount_minor"
       OR checkout_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
       OR checkout_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id" THEN
      RAISE EXCEPTION 'setup consent revision requires exact completed Checkout evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF credit_row."auto_top_up_consent_revision_id" IS NULL
     OR credit_row."stripe_payment_method_id" IS NULL
     OR credit_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id" THEN
    RAISE EXCEPTION 'customer option update must reuse the current Setup-verified payment method'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_consent_revisions_coherence"
  BEFORE INSERT ON "billing_credit_auto_top_up_consent_revisions"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_consent_revision_coherence"();

CREATE FUNCTION "billing_credit_account_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  team_org_id TEXT;
  customer_row "billing_stripe_customers"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  consent_changed BOOLEAN;
BEGIN
  consent_changed := TG_OP = 'INSERT';
  IF TG_OP = 'INSERT' AND NEW."balance_microcredits" <> 0 THEN
    RAISE EXCEPTION 'new credit accounts must start at zero balance'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    consent_changed := ROW(
      NEW."auto_top_up_policy_id",
      NEW."auto_top_up_service_id", NEW."auto_top_up_app_key_id",
      NEW."auto_top_up_consent_revision_id",
      NEW."auto_top_up_option_id", NEW."auto_top_up_threshold_microcredits",
      NEW."auto_top_up_refill_offer_id", NEW."auto_top_up_monthly_charge_cap_minor",
      NEW."auto_top_up_consent_version", NEW."auto_top_up_consented_at",
      NEW."auto_top_up_consented_by_user_id", NEW."stripe_payment_method_id",
      NEW."payment_method_summary"
    ) IS DISTINCT FROM ROW(
      OLD."auto_top_up_policy_id",
      OLD."auto_top_up_service_id", OLD."auto_top_up_app_key_id",
      OLD."auto_top_up_consent_revision_id",
      OLD."auto_top_up_option_id", OLD."auto_top_up_threshold_microcredits",
      OLD."auto_top_up_refill_offer_id", OLD."auto_top_up_monthly_charge_cap_minor",
      OLD."auto_top_up_consent_version", OLD."auto_top_up_consented_at",
      OLD."auto_top_up_consented_by_user_id", OLD."stripe_payment_method_id",
      OLD."payment_method_summary"
    );
    IF OLD."auto_top_up_state" IN ('PAUSED', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
       AND NEW."auto_top_up_state" = 'ACTIVE'
       AND NOT consent_changed THEN
      RAISE EXCEPTION 'automatic top-up recovery requires a new verified consent revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "org_id" INTO team_org_id FROM "teams" WHERE "id" = NEW."team_id";
  SELECT * INTO customer_row FROM "billing_stripe_customers" WHERE "id" = NEW."customer_id";
  IF team_org_id IS DISTINCT FROM NEW."org_id"
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR customer_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR customer_row."scope" IS DISTINCT FROM 'TEAM'
     OR customer_row."scope_key" IS DISTINCT FROM NEW."org_id" || ':' || NEW."team_id" THEN
    RAISE EXCEPTION 'credit account must bind one exact team-scoped Stripe customer'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."auto_top_up_policy_id" IS NOT NULL THEN
    SELECT * INTO policy_row
    FROM "billing_credit_funding_policies" WHERE "id" = NEW."auto_top_up_policy_id";
    SELECT * INTO option_row
    FROM "billing_credit_auto_top_up_options" WHERE "id" = NEW."auto_top_up_option_id";
    SELECT * INTO offer_row
    FROM "billing_credit_top_up_offers" WHERE "id" = NEW."auto_top_up_refill_offer_id";
    SELECT * INTO revision_row
    FROM "billing_credit_auto_top_up_consent_revisions"
    WHERE "id" = NEW."auto_top_up_consent_revision_id";
    PERFORM "billing_assert_credit_app_key_service"(
      NEW."auto_top_up_service_id", NEW."auto_top_up_app_key_id"
    );
    IF consent_changed AND NEW."auto_top_up_state" <> 'DISABLED' THEN
      PERFORM "billing_assert_credit_app_key"(
        NEW."auto_top_up_service_id", NEW."auto_top_up_app_key_id"
      );
      PERFORM "billing_assert_credit_team_manager"(
        NEW."org_id", NEW."team_id", NEW."auto_top_up_consented_by_user_id"
      );
    END IF;
    IF policy_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR revision_row."credit_account_id" IS DISTINCT FROM NEW."id"
       OR revision_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR revision_row."org_id" IS DISTINCT FROM NEW."org_id"
       OR revision_row."team_id" IS DISTINCT FROM NEW."team_id"
       OR revision_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR revision_row."app_key_id" IS DISTINCT FROM NEW."auto_top_up_app_key_id"
       OR revision_row."policy_id" IS DISTINCT FROM NEW."auto_top_up_policy_id"
       OR revision_row."option_id" IS DISTINCT FROM NEW."auto_top_up_option_id"
       OR revision_row."refill_offer_id" IS DISTINCT FROM NEW."auto_top_up_refill_offer_id"
       OR revision_row."consent_version" IS DISTINCT FROM NEW."auto_top_up_consent_version"
       OR revision_row."threshold_microcredits" IS DISTINCT FROM NEW."auto_top_up_threshold_microcredits"
       OR revision_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."auto_top_up_monthly_charge_cap_minor"
       OR revision_row."consented_at" IS DISTINCT FROM NEW."auto_top_up_consented_at"
       OR revision_row."consented_by_user_id" IS DISTINCT FROM NEW."auto_top_up_consented_by_user_id"
       OR revision_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id"
       OR revision_row."payment_method_summary" IS DISTINCT FROM NEW."payment_method_summary"
       OR policy_row."currency" IS DISTINCT FROM 'USD'
       OR NOT policy_row."automatic_top_up_enabled"
       OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."auto_top_up_consent_version"
       OR option_row."policy_id" IS DISTINCT FROM policy_row."id"
       OR option_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR option_row."refill_offer_id" IS DISTINCT FROM offer_row."id"
       OR offer_row."policy_id" IS DISTINCT FROM policy_row."id"
       OR offer_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR NOT offer_row."automatic_top_up_eligible"
       OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."auto_top_up_threshold_microcredits"
       OR option_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."auto_top_up_monthly_charge_cap_minor"
       OR (
         consent_changed AND NEW."auto_top_up_state" <> 'DISABLED'
         AND (NOT policy_row."active" OR NOT option_row."active" OR NOT offer_row."active")
       ) THEN
      RAISE EXCEPTION 'credit account automatic top-up snapshot is incoherent'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_accounts_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_account_coherence"();

CREATE FUNCTION "billing_credit_account_balance_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."balance_microcredits" IS DISTINCT FROM OLD."balance_microcredits"
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'credit balance may change only through an append-only entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_accounts_balance_guard"
  BEFORE UPDATE ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_account_balance_guard"();

CREATE FUNCTION "billing_credit_admin_adjustment_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  creator_email TEXT;
  trusted_admin_domain TEXT;
BEGIN
  trusted_admin_domain := NULLIF(current_setting('app.admin_auth_domain', true), '');
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  SELECT "email"::text INTO creator_email
  FROM "users"
  WHERE "id" = NEW."created_by_user_id";
  IF account_row."id" IS NULL
     OR creator_email IS NULL
     OR trusted_admin_domain IS NULL
     OR lower(rtrim(trusted_admin_domain, '.'))
       IS DISTINCT FROM lower(rtrim(NEW."created_by_admin_domain", '.'))
     OR account_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR account_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR account_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR creator_email::citext IS DISTINCT FROM NEW."created_by_email"::citext
     OR NOT EXISTS (
       SELECT 1 FROM "domain_roles" AS role
       WHERE role."user_id" = NEW."created_by_user_id"
         AND lower(rtrim(role."domain", '.')) = lower(rtrim(NEW."created_by_admin_domain", '.'))
         AND role."role" = 'SUPERUSER'
     ) THEN
    RAISE EXCEPTION 'credit admin adjustment requires exact team and superuser evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_admin_adjustments_coherence"
  BEFORE INSERT ON "billing_credit_admin_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_admin_adjustment_coherence"();

CREATE FUNCTION "billing_credit_admin_adjustment_entry_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_row "billing_credit_entries"%ROWTYPE;
BEGIN
  SELECT * INTO entry_row
  FROM "billing_credit_entries"
  WHERE "id" = NEW."credit_entry_id";
  IF NOT FOUND
     OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR entry_row."service_id" IS NOT NULL
     OR entry_row."app_key_id" IS NOT NULL
     OR entry_row."attributed_user_id" IS NOT NULL
     OR entry_row."kind" IS DISTINCT FROM 'ADJUSTMENT'
     OR entry_row."direction" IS DISTINCT FROM (CASE
       WHEN NEW."signed_amount_microcredits" > 0
         THEN 'CREDIT'::"BillingCreditEntryDirection"
       ELSE 'DEBIT'::"BillingCreditEntryDirection"
     END)
     OR entry_row."amount_microcredits"::numeric
       IS DISTINCT FROM abs(NEW."signed_amount_microcredits"::numeric)
     OR entry_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR entry_row."source_type" IS DISTINCT FROM 'credit_admin_adjustment'
     OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION 'credit admin adjustment must commit with one exact immutable entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "billing_credit_admin_adjustments_exact_entry"
  AFTER INSERT ON "billing_credit_admin_adjustments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_admin_adjustment_entry_coherence"();

CREATE FUNCTION "billing_credit_payment_adjustment_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  original_row "billing_credit_entries"%ROWTYPE;
  webhook_row "billing_stripe_webhook_events"%ROWTYPE;
  adjusted_before NUMERIC;
  account_livemode BOOLEAN;
  original_payment_intent_id TEXT;
BEGIN
  SELECT * INTO original_row
  FROM "billing_credit_entries"
  WHERE "id" = NEW."original_entry_id"
  FOR UPDATE;
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id";
  SELECT * INTO webhook_row
  FROM "billing_stripe_webhook_events"
  WHERE "id" = NEW."webhook_event_id";
  SELECT "livemode" INTO account_livemode
  FROM "billing_stripe_accounts"
  WHERE "id" = NEW."account_id";
  IF original_row."kind" = 'TOP_UP' THEN
    SELECT checkout."stripe_payment_intent_id" INTO original_payment_intent_id
    FROM "billing_credit_top_up_checkouts" AS checkout
    WHERE checkout."credit_entry_id" = original_row."id"
      AND checkout."status" = 'COMPLETE';
  ELSIF original_row."kind" = 'AUTOMATIC_TOP_UP' THEN
    SELECT attempt."stripe_payment_intent_id" INTO original_payment_intent_id
    FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."credit_entry_id" = original_row."id"
      AND attempt."status" = 'SUCCEEDED';
  END IF;
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF original_row."id" IS NULL
     OR account_row."id" IS NULL
     OR webhook_row."id" IS NULL
     OR account_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR original_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR original_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR original_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR original_row."kind" NOT IN ('TOP_UP', 'AUTOMATIC_TOP_UP')
     OR original_row."direction" IS DISTINCT FROM 'CREDIT'
     OR original_payment_intent_id IS DISTINCT FROM NEW."stripe_payment_intent_id"
     OR webhook_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR webhook_row."livemode" IS DISTINCT FROM NEW."livemode"
     OR webhook_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_object_id"
     OR webhook_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
     OR webhook_row."stripe_charge_id" IS DISTINCT FROM NEW."stripe_charge_id"
     OR webhook_row."amount_minor" IS DISTINCT FROM NEW."amount_minor"
     OR webhook_row."currency" IS DISTINCT FROM NEW."currency"
     OR webhook_row."stripe_created_at" IS DISTINCT FROM NEW."occurred_at"
     OR account_livemode IS DISTINCT FROM NEW."livemode"
     OR (
       NEW."kind" = 'REFUND'
       AND webhook_row."type" IS DISTINCT FROM 'refund.created'
     )
     OR (
       NEW."kind" = 'DISPUTE'
       AND webhook_row."type" IS DISTINCT FROM 'charge.dispute.created'
     ) THEN
    RAISE EXCEPTION 'Stripe payment adjustment evidence is not exact'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(adjustment."amount_microcredits"), 0)
    INTO adjusted_before
  FROM "billing_credit_payment_adjustments" AS adjustment
  WHERE adjustment."original_entry_id" = NEW."original_entry_id";
  IF adjusted_before + NEW."amount_microcredits"::numeric
       > original_row."amount_microcredits"::numeric
     THEN
    RAISE EXCEPTION 'Stripe payment adjustments exceed the original paid credits'
      USING ERRCODE = '23514';
  END IF;
  UPDATE "billing_credit_accounts"
  SET "auto_top_up_state" = 'NEEDS_REVIEW',
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."credit_account_id"
    AND "auto_top_up_state" <> 'DISABLED';
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_payment_adjustments_coherence"
  BEFORE INSERT ON "billing_credit_payment_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_payment_adjustment_coherence"();

CREATE FUNCTION "billing_credit_payment_adjustment_entry_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original_row "billing_credit_entries"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
BEGIN
  SELECT * INTO original_row FROM "billing_credit_entries"
    WHERE "id" = NEW."original_entry_id";
  SELECT * INTO entry_row FROM "billing_credit_entries"
    WHERE "id" = NEW."credit_entry_id";
  IF NOT FOUND
     OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR entry_row."attributed_user_id" IS DISTINCT FROM original_row."attributed_user_id"
     OR entry_row."kind"::text IS DISTINCT FROM NEW."kind"::text
     OR entry_row."direction" IS DISTINCT FROM 'DEBIT'
     OR entry_row."amount_microcredits" IS DISTINCT FROM NEW."amount_microcredits"
     OR entry_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR entry_row."source_type" IS DISTINCT FROM 'credit_payment_adjustment'
     OR entry_row."source_id" IS DISTINCT FROM NEW."id"
     OR entry_row."reverses_entry_id" IS DISTINCT FROM NEW."original_entry_id" THEN
    RAISE EXCEPTION 'Stripe payment adjustment must commit with one exact debit entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "billing_credit_payment_adjustments_exact_entry"
  AFTER INSERT ON "billing_credit_payment_adjustments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_payment_adjustment_entry_coherence"();

CREATE FUNCTION "billing_credit_portfolio_snapshot_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  latest_cursor TEXT;
  latest_captured_at TIMESTAMP(3);
  perspective_identifier TEXT;
BEGIN
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  SELECT "identifier" INTO perspective_identifier
  FROM "billing_services"
  WHERE "id" = NEW."perspective_service_id";
  IF NOT FOUND
     OR account_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR account_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR account_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR perspective_identifier IS DISTINCT FROM NEW."perspective_product" THEN
    RAISE EXCEPTION 'Ledger portfolio snapshot does not match the exact team credit account'
      USING ERRCODE = '23514';
  END IF;
  SELECT snapshot."ledger_snapshot_cursor", snapshot."captured_at"
    INTO latest_cursor, latest_captured_at
  FROM "billing_credit_portfolio_snapshots" AS snapshot
  WHERE snapshot."credit_account_id" = NEW."credit_account_id"
    AND snapshot."billing_month" = NEW."billing_month"
  ORDER BY snapshot."captured_at" DESC, snapshot."ledger_snapshot_cursor" DESC
  LIMIT 1;
  IF latest_cursor IS NOT NULL
     AND NEW."ledger_snapshot_cursor" IS DISTINCT FROM latest_cursor
     AND NEW."captured_at" <= latest_captured_at THEN
    RAISE EXCEPTION 'stale Ledger portfolio snapshot cannot correct newer team usage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_portfolio_snapshots_coherence"
  BEFORE INSERT ON "billing_credit_portfolio_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_portfolio_snapshot_coherence"();

CREATE FUNCTION "billing_credit_entry_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  reversed_row "billing_credit_entries"%ROWTYPE;
  adjustment_row "billing_credit_admin_adjustments"%ROWTYPE;
  payment_adjustment_row "billing_credit_payment_adjustments"%ROWTYPE;
  signed_delta NUMERIC;
  next_balance NUMERIC;
BEGIN
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  IF NOT FOUND OR account_row."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'credit entry does not match its account'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'ADJUSTMENT' THEN
    SELECT * INTO adjustment_row
    FROM "billing_credit_admin_adjustments"
    WHERE "id" = NEW."source_id";
    IF NOT FOUND
       OR NEW."source_type" IS DISTINCT FROM 'credit_admin_adjustment'
       OR NEW."service_id" IS NOT NULL
       OR NEW."app_key_id" IS NOT NULL
       OR NEW."attributed_user_id" IS NOT NULL
       OR adjustment_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR adjustment_row."credit_entry_id" IS DISTINCT FROM NEW."id"
       OR adjustment_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
       OR abs(adjustment_row."signed_amount_microcredits"::numeric)
         IS DISTINCT FROM NEW."amount_microcredits"::numeric
       OR NEW."direction" IS DISTINCT FROM (CASE
         WHEN adjustment_row."signed_amount_microcredits" > 0
           THEN 'CREDIT'::"BillingCreditEntryDirection"
         ELSE 'DEBIT'::"BillingCreditEntryDirection"
       END) THEN
      RAISE EXCEPTION 'admin credit adjustment entry lacks exact immutable evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."service_id" IS NULL OR NEW."app_key_id" IS NULL THEN
      RAISE EXCEPTION 'product credit entries require exact service and app-key provenance'
        USING ERRCODE = '23514';
    END IF;
    PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
    IF NEW."kind" IN ('REFUND', 'DISPUTE') THEN
      SELECT * INTO payment_adjustment_row
      FROM "billing_credit_payment_adjustments"
      WHERE "id" = NEW."source_id";
      IF NOT FOUND
         OR NEW."source_type" IS DISTINCT FROM 'credit_payment_adjustment'
         OR payment_adjustment_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
         OR payment_adjustment_row."service_id" IS DISTINCT FROM NEW."service_id"
         OR payment_adjustment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
         OR payment_adjustment_row."kind"::text IS DISTINCT FROM NEW."kind"::text
         OR payment_adjustment_row."original_entry_id" IS DISTINCT FROM NEW."reverses_entry_id"
         OR payment_adjustment_row."credit_entry_id" IS DISTINCT FROM NEW."id"
         OR payment_adjustment_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
         OR payment_adjustment_row."amount_microcredits" IS DISTINCT FROM NEW."amount_microcredits" THEN
        RAISE EXCEPTION 'payment debit entry lacks exact immutable Stripe evidence'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW."kind" IN ('REFUND', 'DISPUTE') THEN
    IF NEW."reverses_entry_id" IS NULL THEN
      RAISE EXCEPTION 'credit debit/reversal requires an exact source entry'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO reversed_row
    FROM "billing_credit_entries"
    WHERE "id" = NEW."reverses_entry_id"
    FOR KEY SHARE;
    IF NOT FOUND
       OR reversed_row."credit_account_id" <> NEW."credit_account_id"
       OR reversed_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR reversed_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR reversed_row."attributed_user_id" IS DISTINCT FROM NEW."attributed_user_id"
       OR reversed_row."currency" <> NEW."currency"
       OR reversed_row."direction" = NEW."direction"
       OR (
         NEW."kind" IN ('REFUND', 'DISPUTE')
         AND (
           reversed_row."kind" NOT IN ('TOP_UP', 'AUTOMATIC_TOP_UP')
           OR reversed_row."direction" <> 'CREDIT'
           OR NEW."direction" <> 'DEBIT'
           OR NEW."amount_microcredits" > reversed_row."amount_microcredits"
         )
       ) THEN
      RAISE EXCEPTION 'credit payment debit does not exactly match its source entry'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."reverses_entry_id" IS NOT NULL THEN
    RAISE EXCEPTION 'only a verified refund or dispute may reference a paid entry'
      USING ERRCODE = '23514';
  END IF;

  signed_delta := CASE NEW."direction"
    WHEN 'CREDIT' THEN NEW."amount_microcredits"::numeric
    ELSE -NEW."amount_microcredits"::numeric
  END;
  next_balance := account_row."balance_microcredits"::numeric + signed_delta;
  IF next_balance < -9223372036854775808 OR next_balance > 9223372036854775807 THEN
    RAISE EXCEPTION 'credit balance exceeds supported precision'
      USING ERRCODE = '22003';
  END IF;
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')
     AND NEW."direction" = 'DEBIT'
     AND next_balance < 0 THEN
    RAISE EXCEPTION 'rated usage cannot consume more credits than are available'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."balance_after_microcredits"::numeric <> next_balance THEN
    RAISE EXCEPTION 'credit entry balance-after does not match the locked account balance'
      USING ERRCODE = '40001';
  END IF;

  UPDATE "billing_credit_accounts"
  SET "balance_microcredits" = next_balance::bigint,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."credit_account_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_entries_apply_locked_balance"
  BEFORE INSERT ON "billing_credit_entries"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_entry_apply"();

CREATE FUNCTION "billing_credit_entry_source_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'TOP_UP' AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_top_up_checkouts" AS checkout
    WHERE checkout."id" = NEW."source_id"
      AND NEW."source_type" = 'credit_top_up_checkout'
      AND checkout."status" = 'COMPLETE'
      AND checkout."credit_entry_id" = NEW."id"
      AND checkout."credit_account_id" = NEW."credit_account_id"
      AND checkout."service_id" = NEW."service_id"
      AND checkout."app_key_id" = NEW."app_key_id"
      AND checkout."requested_by_user_id" = NEW."attributed_user_id"
      AND checkout."credits_received_microcredits" = NEW."amount_microcredits"
  ) THEN
    RAISE EXCEPTION 'top-up entry must commit with exact paid checkout evidence'
      USING ERRCODE = '23514';
  ELSIF NEW."kind" = 'AUTOMATIC_TOP_UP' AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."id" = NEW."source_id"
      AND NEW."source_type" = 'credit_auto_top_up_attempt'
      AND attempt."status" = 'SUCCEEDED'
      AND attempt."credit_entry_id" = NEW."id"
      AND attempt."credit_account_id" = NEW."credit_account_id"
      AND attempt."service_id" = NEW."service_id"
      AND attempt."app_key_id" = NEW."app_key_id"
      AND attempt."attributed_user_id" = NEW."attributed_user_id"
      AND attempt."credits_received_microcredits" = NEW."amount_microcredits"
  ) THEN
    RAISE EXCEPTION 'automatic top-up entry must commit with exact successful attempt evidence'
      USING ERRCODE = '23514';
  ELSIF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')
    AND NOT EXISTS (
      SELECT 1 FROM "billing_credit_usage_settlement_adjustments" AS adjustment
      WHERE adjustment."id" = NEW."source_id"
        AND NEW."source_type" = 'credit_usage_settlement_adjustment'
        AND adjustment."credit_entry_id" = NEW."id"
        AND adjustment."credit_account_id" = NEW."credit_account_id"
        AND adjustment."service_id" = NEW."service_id"
        AND adjustment."app_key_id" = NEW."app_key_id"
        AND abs(adjustment."delta_credits_consumed_microcredits"::numeric)
          = NEW."amount_microcredits"::numeric
    ) THEN
    RAISE EXCEPTION 'usage entry must commit with exact portfolio settlement evidence'
      USING ERRCODE = '23514';
  ELSIF NEW."kind" IN ('REFUND', 'DISPUTE') AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_payment_adjustments" AS adjustment
    WHERE adjustment."id" = NEW."source_id"
      AND NEW."source_type" = 'credit_payment_adjustment'
      AND adjustment."credit_entry_id" = NEW."id"
      AND adjustment."credit_account_id" = NEW."credit_account_id"
      AND adjustment."service_id" = NEW."service_id"
      AND adjustment."app_key_id" = NEW."app_key_id"
      AND adjustment."kind"::text = NEW."kind"::text
      AND adjustment."original_entry_id" = NEW."reverses_entry_id"
      AND adjustment."amount_microcredits" = NEW."amount_microcredits"
  ) THEN
    RAISE EXCEPTION 'payment debit entry must commit with exact Stripe evidence'
      USING ERRCODE = '23514';
  ELSIF NEW."kind" = 'ADJUSTMENT' AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_admin_adjustments" AS adjustment
    WHERE adjustment."id" = NEW."source_id"
      AND NEW."source_type" = 'credit_admin_adjustment'
      AND adjustment."credit_entry_id" = NEW."id"
      AND adjustment."credit_account_id" = NEW."credit_account_id"
      AND abs(adjustment."signed_amount_microcredits"::numeric)
        = NEW."amount_microcredits"::numeric
  ) THEN
    RAISE EXCEPTION 'admin entry must commit with exact superuser evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "billing_credit_entries_require_exact_source"
  AFTER INSERT ON "billing_credit_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_entry_source_coherence"();

CREATE FUNCTION "billing_credit_top_up_checkout_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  catalog_row "billing_credit_top_up_catalogs"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  completion_event_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'CREATING'
    OR NEW."stripe_checkout_session_id" IS NOT NULL
    OR NEW."stripe_payment_intent_id" IS NOT NULL
    OR NEW."completion_webhook_event_id" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
    OR NEW."credit_entry_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new credit checkout must begin creating without payment proof'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETE' THEN
    IF ROW(
      NEW."status", NEW."stripe_checkout_session_id", NEW."stripe_payment_intent_id",
      NEW."completion_webhook_event_id", NEW."completed_at", NEW."credit_entry_id"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."stripe_checkout_session_id", OLD."stripe_payment_intent_id",
      OLD."completion_webhook_event_id", OLD."completed_at", OLD."credit_entry_id"
    ) THEN
      RAISE EXCEPTION 'completed credit checkout proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."offer_id";
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = offer_row."policy_id";
  SELECT * INTO catalog_row FROM "billing_credit_top_up_catalogs"
    WHERE "id" = NEW."catalog_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
    PERFORM "billing_assert_credit_team_manager"(
      credit_row."org_id", credit_row."team_id", NEW."requested_by_user_id"
    );
  END IF;

  IF length(btrim(NEW."actor_jti")) = 0
     OR credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."customer_id" IS DISTINCT FROM NEW."customer_id"
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."org_id" IS DISTINCT FROM credit_row."org_id"
     OR customer_row."team_id" IS DISTINCT FROM credit_row."team_id"
     OR customer_row."scope" IS DISTINCT FROM 'TEAM'
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."id" IS NULL
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."top_up_enabled"
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."key" IS DISTINCT FROM offer_row."catalog_key"
     OR catalog_row."version" IS DISTINCT FROM offer_row."catalog_version"
     OR catalog_row."currency" IS DISTINCT FROM 'USD'
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM offer_row."payment_amount_minor"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM offer_row."credits_received_microcredits"
     OR NEW."currency" <> 'USD'
     OR (
       TG_OP = 'INSERT'
       AND (
         NOT policy_row."active"
         OR NOT offer_row."active"
         OR catalog_row."stripe_price_id" IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'credit top-up checkout binding is incoherent'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'COMPLETE' THEN
    SELECT * INTO completion_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."completion_webhook_event_id";
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    IF completion_event_row."id" IS NULL
       OR completion_event_row."type" IS DISTINCT FROM 'payment_intent.succeeded'
       OR completion_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR completion_event_row."livemode" IS DISTINCT FROM account_livemode
       OR completion_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR completion_event_row."stripe_checkout_session_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR completion_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR completion_event_row."amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
       OR completion_event_row."currency" IS DISTINCT FROM NEW."currency"
       OR completion_event_row."stripe_created_at" IS DISTINCT FROM NEW."completed_at"
       OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS DISTINCT FROM NEW."requested_by_user_id"
       OR entry_row."kind" IS DISTINCT FROM 'TOP_UP'
       OR entry_row."direction" IS DISTINCT FROM 'CREDIT'
       OR entry_row."amount_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
       OR entry_row."source_type" IS DISTINCT FROM 'credit_top_up_checkout'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'completed credit checkout does not match its immutable entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_top_up_checkouts_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_top_up_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_top_up_checkout_coherence"();

CREATE FUNCTION "billing_credit_setup_checkout_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  completion_event_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'CREATING'
    OR NEW."stripe_checkout_session_id" IS NOT NULL
    OR NEW."stripe_setup_intent_id" IS NOT NULL
    OR NEW."stripe_payment_method_id" IS NOT NULL
    OR NEW."completion_webhook_event_id" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new automatic top-up setup must begin creating without proof'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETE' THEN
    IF ROW(
      NEW."status", NEW."stripe_checkout_session_id", NEW."stripe_setup_intent_id",
      NEW."stripe_payment_method_id", NEW."completion_webhook_event_id", NEW."completed_at"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."stripe_checkout_session_id", OLD."stripe_setup_intent_id",
      OLD."stripe_payment_method_id", OLD."completion_webhook_event_id", OLD."completed_at"
    ) THEN
      RAISE EXCEPTION 'completed automatic top-up setup proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = NEW."policy_id";
  SELECT * INTO option_row FROM "billing_credit_auto_top_up_options"
    WHERE "id" = NEW."option_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."refill_offer_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
    PERFORM "billing_assert_credit_team_manager"(
      credit_row."org_id", credit_row."team_id", NEW."requested_by_user_id"
    );
  END IF;

  IF length(btrim(NEW."actor_jti")) = 0
     OR credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."customer_id" IS DISTINCT FROM NEW."customer_id"
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."team_id" IS DISTINCT FROM credit_row."team_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
     OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
     OR option_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
     OR offer_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."credits_received_microcredits" IS DISTINCT FROM NEW."refill_credits_microcredits"
     OR offer_row."payment_amount_minor" IS DISTINCT FROM NEW."refill_payment_amount_minor"
     OR NOT offer_row."automatic_top_up_eligible"
     OR NOT EXISTS (
       SELECT 1 FROM "billing_credit_top_up_catalogs" AS catalog
       WHERE catalog."account_id" = NEW."account_id"
         AND catalog."key" = offer_row."catalog_key"
         AND catalog."version" = offer_row."catalog_version"
         AND catalog."payment_amount_minor" = offer_row."payment_amount_minor"
         AND catalog."credits_received_microcredits" = offer_row."credits_received_microcredits"
     )
     OR (
       TG_OP = 'INSERT'
       AND (
         NOT policy_row."active"
         OR NOT option_row."active"
         OR NOT offer_row."active"
         OR NOT EXISTS (
           SELECT 1 FROM "billing_credit_top_up_catalogs" AS catalog
           WHERE catalog."account_id" = NEW."account_id"
             AND catalog."key" = offer_row."catalog_key"
             AND catalog."version" = offer_row."catalog_version"
             AND catalog."stripe_price_id" IS NOT NULL
         )
       )
     ) THEN
    RAISE EXCEPTION 'automatic top-up setup binding is incoherent'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'COMPLETE' THEN
    SELECT * INTO completion_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."completion_webhook_event_id";
    IF completion_event_row."id" IS NULL
       OR completion_event_row."type" IS DISTINCT FROM 'setup_intent.succeeded'
       OR completion_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR completion_event_row."livemode" IS DISTINCT FROM account_livemode
       OR completion_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_setup_intent_id"
       OR completion_event_row."stripe_checkout_session_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_setup_intent_id" IS DISTINCT FROM NEW."stripe_setup_intent_id"
       OR completion_event_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id"
       OR completion_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR completion_event_row."stripe_created_at" IS DISTINCT FROM NEW."completed_at" THEN
      RAISE EXCEPTION 'completed automatic top-up setup lacks exact Stripe evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_setup_checkouts_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_setup_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_setup_checkout_coherence"();

CREATE FUNCTION "billing_credit_auto_top_up_attempt_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  success_event_row "billing_stripe_webhook_events"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  catalog_row "billing_credit_top_up_catalogs"%ROWTYPE;
  trigger_row "billing_credit_entries"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  charged_before_minor BIGINT;
  account_livemode BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."billing_month" := to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM');
    NEW."created_at" := CURRENT_TIMESTAMP;
    IF NEW."status" IS DISTINCT FROM 'PENDING'
       OR NEW."stripe_payment_intent_id" IS NOT NULL
       OR NEW."success_webhook_event_id" IS NOT NULL
       OR NEW."credit_entry_id" IS NOT NULL
       OR NEW."resolved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'new automatic top-up attempts must begin pending without payment proof'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id" FOR UPDATE;
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = credit_row."customer_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  SELECT * INTO option_row FROM "billing_credit_auto_top_up_options"
    WHERE "id" = NEW."option_id";
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = option_row."policy_id";
  SELECT * INTO revision_row FROM "billing_credit_auto_top_up_consent_revisions"
    WHERE "id" = NEW."consent_revision_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."offer_id";
  SELECT * INTO catalog_row FROM "billing_credit_top_up_catalogs"
    WHERE "id" = NEW."catalog_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");

  IF credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."auto_top_up_consent_revision_id" IS DISTINCT FROM NEW."consent_revision_id"
     OR credit_row."auto_top_up_policy_id" IS DISTINCT FROM policy_row."id"
     OR revision_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR revision_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR revision_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR revision_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR revision_row."policy_id" IS DISTINCT FROM policy_row."id"
     OR revision_row."option_id" IS DISTINCT FROM NEW."option_id"
     OR revision_row."refill_offer_id" IS DISTINCT FROM NEW."offer_id"
     OR revision_row."consented_by_user_id" IS DISTINCT FROM NEW."attributed_user_id"
     OR revision_row."consent_version" IS DISTINCT FROM NEW."consent_version"
     OR revision_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
     OR revision_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
     OR revision_row."refill_payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR revision_row."refill_credits_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."offer_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR NOT offer_row."automatic_top_up_eligible"
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."key" IS DISTINCT FROM offer_row."catalog_key"
     OR catalog_row."version" IS DISTINCT FROM offer_row."catalog_version"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM offer_row."payment_amount_minor"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM offer_row."credits_received_microcredits"
     OR (
       TG_OP = 'INSERT'
       AND (
         credit_row."auto_top_up_state" IS DISTINCT FROM 'ACTIVE'
         OR credit_row."auto_top_up_service_id" IS DISTINCT FROM NEW."service_id"
         OR credit_row."auto_top_up_app_key_id" IS DISTINCT FROM NEW."app_key_id"
         OR credit_row."auto_top_up_consented_by_user_id" IS DISTINCT FROM NEW."attributed_user_id"
         OR credit_row."auto_top_up_option_id" IS DISTINCT FROM NEW."option_id"
         OR credit_row."auto_top_up_refill_offer_id" IS DISTINCT FROM NEW."offer_id"
         OR credit_row."auto_top_up_consent_version" IS DISTINCT FROM NEW."consent_version"
         OR credit_row."auto_top_up_threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
         OR credit_row."auto_top_up_monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
         OR credit_row."stripe_payment_method_id" IS NULL
         OR NOT policy_row."active"
         OR NOT option_row."active"
         OR NOT offer_row."active"
         OR catalog_row."stripe_price_id" IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'automatic credit top-up attempt is not the consented team configuration'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW."observed_balance_microcredits" IS DISTINCT FROM credit_row."balance_microcredits"
    OR NEW."observed_balance_microcredits" >= NEW."threshold_microcredits"
  ) THEN
    RAISE EXCEPTION 'automatic top-up requires the locked balance to be below threshold'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(SUM(attempt."payment_amount_minor"), 0)
      INTO charged_before_minor
    FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."credit_account_id" = NEW."credit_account_id"
      AND attempt."billing_month" = NEW."billing_month"
      AND attempt."status" = 'SUCCEEDED';
    IF NEW."charged_this_month_before_minor" IS DISTINCT FROM charged_before_minor
       OR charged_before_minor + NEW."payment_amount_minor"
         > NEW."monthly_charge_cap_minor" THEN
      RAISE EXCEPTION 'automatic top-up monthly charge snapshot or cap is stale'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELED') THEN
    IF ROW(
      NEW."stripe_payment_intent_id", NEW."success_webhook_event_id", NEW."status",
      NEW."failure_code", NEW."credit_entry_id", NEW."resolved_at"
    ) IS DISTINCT FROM ROW(
      OLD."stripe_payment_intent_id", OLD."success_webhook_event_id", OLD."status",
      OLD."failure_code", OLD."credit_entry_id", OLD."resolved_at"
    ) THEN
      RAISE EXCEPTION 'terminal automatic top-up attempt proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."trigger_entry_id" IS NOT NULL THEN
    SELECT * INTO trigger_row FROM "billing_credit_entries"
      WHERE "id" = NEW."trigger_entry_id";
    PERFORM "billing_assert_credit_app_key_service"(
      trigger_row."service_id", trigger_row."app_key_id"
    );
    IF trigger_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR trigger_row."kind" NOT IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')
       OR trigger_row."direction" IS DISTINCT FROM 'DEBIT' THEN
      RAISE EXCEPTION 'automatic top-up trigger entry is not exact aggregate usage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'SUCCEEDED' THEN
    SELECT * INTO success_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."success_webhook_event_id";
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    IF success_event_row."id" IS NULL
       OR success_event_row."type" IS DISTINCT FROM 'payment_intent.succeeded'
       OR success_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR success_event_row."livemode" IS DISTINCT FROM account_livemode
       OR success_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR success_event_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR success_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR success_event_row."stripe_payment_method_id" IS DISTINCT FROM revision_row."stripe_payment_method_id"
       OR success_event_row."amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
       OR success_event_row."currency" IS DISTINCT FROM 'USD'
       OR success_event_row."stripe_created_at" IS DISTINCT FROM NEW."resolved_at"
       OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS DISTINCT FROM NEW."attributed_user_id"
       OR entry_row."kind" IS DISTINCT FROM 'AUTOMATIC_TOP_UP'
       OR entry_row."direction" IS DISTINCT FROM 'CREDIT'
       OR entry_row."amount_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
       OR entry_row."source_type" IS DISTINCT FROM 'credit_auto_top_up_attempt'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'successful automatic top-up does not match its immutable entry'
      USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" = 'REQUIRES_ACTION' THEN
      UPDATE "billing_credit_accounts"
      SET "auto_top_up_state" = 'REQUIRES_ACTION', "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."credit_account_id";
    ELSIF NEW."status" IN ('NEEDS_REVIEW', 'FAILED', 'CANCELED') THEN
      UPDATE "billing_credit_accounts"
      SET "auto_top_up_state" = 'NEEDS_REVIEW', "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."credit_account_id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_auto_top_up_attempts_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_auto_top_up_attempts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_auto_top_up_attempt_coherence"();

CREATE FUNCTION "billing_credit_settlement_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  tariff_row "billing_tariffs"%ROWTYPE;
  subscription_row "billing_stripe_subscriptions"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO tariff_row FROM "billing_tariffs"
    WHERE "id" = NEW."tariff_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
  END IF;
  IF credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."currency" IS DISTINCT FROM 'USD'
     OR tariff_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR tariff_row."currency" IS DISTINCT FROM 'USD'
     OR NEW."currency" <> 'USD' THEN
    RAISE EXCEPTION 'credit settlement must use the shared account and exact USD tariff service'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."subscription_id" IS NOT NULL THEN
    SELECT * INTO subscription_row FROM "billing_stripe_subscriptions"
      WHERE "id" = NEW."subscription_id";
    IF subscription_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR subscription_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR subscription_row."tariff_id" IS DISTINCT FROM NEW."tariff_id"
       OR subscription_row."org_id" IS DISTINCT FROM credit_row."org_id"
       OR (
         subscription_row."team_id" IS NOT NULL
         AND subscription_row."team_id" IS DISTINCT FROM credit_row."team_id"
       ) THEN
      RAISE EXCEPTION 'credit settlement subscription does not cover the exact team service'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'PENDING'
    OR NEW."cumulative_rated_usage_amount_micro_minor" <> 0
    OR NEW."cumulative_credits_consumed_microcredits" <> 0
    OR NEW."cumulative_remaining_usage_amount_micro_minor" <> 0
  ) THEN
    RAISE EXCEPTION 'new settlement must begin pending at exact zero cumulative totals'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW."cumulative_rated_usage_amount_micro_minor"
         IS DISTINCT FROM OLD."cumulative_rated_usage_amount_micro_minor"
       OR NEW."cumulative_credits_consumed_microcredits"
         IS DISTINCT FROM OLD."cumulative_credits_consumed_microcredits"
       OR NEW."cumulative_remaining_usage_amount_micro_minor"
         IS DISTINCT FROM OLD."cumulative_remaining_usage_amount_micro_minor"
     )
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'settlement totals may advance only through an immutable adjustment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_usage_settlements_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_usage_settlements"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_settlement_coherence"();

CREATE FUNCTION "billing_credit_settlement_adjustment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  snapshot_row "billing_credit_portfolio_snapshots"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  expected_kind "BillingCreditEntryKind";
  expected_direction "BillingCreditEntryDirection";
  next_sequence INTEGER;
  previous_snapshot_id TEXT;
  previous_snapshot_captured_at TIMESTAMP(3);
BEGIN
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR UPDATE;
  IF NOT FOUND
     OR settlement_row."account_id" <> NEW."account_id"
     OR settlement_row."credit_account_id" <> NEW."credit_account_id"
     OR settlement_row."service_id" <> NEW."service_id"
     OR settlement_row."app_key_id" <> NEW."app_key_id" THEN
    RAISE EXCEPTION 'settlement adjustment does not match its aggregate settlement'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO snapshot_row
  FROM "billing_credit_portfolio_snapshots"
  WHERE "id" = NEW."portfolio_snapshot_id";
  IF NOT FOUND
     OR snapshot_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR snapshot_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR snapshot_row."billing_month" IS DISTINCT FROM settlement_row."billing_month"
     OR snapshot_row."perspective_service_id" IS DISTINCT FROM NEW."service_id"
     OR snapshot_row."contract" IS DISTINCT FROM 'metering-portfolio-v1'
     OR snapshot_row."group_by" IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'settlement adjustment must use the exact team-wide user portfolio snapshot'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(adjustment."sequence"), 0) + 1 INTO next_sequence
  FROM "billing_credit_usage_settlement_adjustments" AS adjustment
  WHERE adjustment."settlement_id" = NEW."settlement_id";
  IF NEW."sequence" <> next_sequence THEN
    RAISE EXCEPTION 'settlement adjustment sequence does not continue the locked chain'
      USING ERRCODE = '40001';
  END IF;
  SELECT previous_snapshot."id", previous_snapshot."captured_at"
    INTO previous_snapshot_id, previous_snapshot_captured_at
  FROM "billing_credit_usage_settlement_adjustments" AS adjustment
  JOIN "billing_credit_portfolio_snapshots" AS previous_snapshot
    ON previous_snapshot."id" = adjustment."portfolio_snapshot_id"
  WHERE adjustment."settlement_id" = NEW."settlement_id"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;
  IF previous_snapshot_id IS NOT NULL
     AND snapshot_row."id" IS DISTINCT FROM previous_snapshot_id
     AND snapshot_row."captured_at" <= previous_snapshot_captured_at THEN
    RAISE EXCEPTION 'settlement adjustment cannot apply an older portfolio snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> settlement_row."cumulative_rated_usage_amount_micro_minor"
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> settlement_row."cumulative_credits_consumed_microcredits"
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> settlement_row."cumulative_remaining_usage_amount_micro_minor"
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'settlement adjustment does not continue the locked cumulative chain'
      USING ERRCODE = '40001';
  END IF;

  IF NEW."delta_credits_consumed_microcredits" <> 0 THEN
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    expected_kind := CASE
      WHEN settlement_row."cumulative_rated_usage_amount_micro_minor" = 0
       AND settlement_row."cumulative_credits_consumed_microcredits" = 0
       AND settlement_row."cumulative_remaining_usage_amount_micro_minor" = 0
        THEN 'USAGE_SETTLEMENT'::"BillingCreditEntryKind"
      ELSE 'USAGE_SETTLEMENT_CORRECTION'::"BillingCreditEntryKind"
    END;
    expected_direction := CASE
      WHEN NEW."delta_credits_consumed_microcredits" > 0
        THEN 'DEBIT'::"BillingCreditEntryDirection"
      ELSE 'CREDIT'::"BillingCreditEntryDirection"
    END;
    IF entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS NOT NULL
       OR entry_row."kind" IS DISTINCT FROM expected_kind
       OR entry_row."direction" IS DISTINCT FROM expected_direction
       OR entry_row."amount_microcredits"::numeric
          IS DISTINCT FROM abs(NEW."delta_credits_consumed_microcredits"::numeric)
       OR entry_row."source_type" IS DISTINCT FROM 'credit_usage_settlement_adjustment'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'settlement adjustment does not match its aggregate credit entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE "billing_credit_usage_settlements"
  SET "cumulative_rated_usage_amount_micro_minor" = NEW."cumulative_rated_usage_amount_micro_minor",
      "cumulative_credits_consumed_microcredits" = NEW."cumulative_credits_consumed_microcredits",
      "cumulative_remaining_usage_amount_micro_minor" = NEW."cumulative_remaining_usage_amount_micro_minor",
      "status" = 'APPLIED',
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."settlement_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_usage_adjustments_apply_projection"
  BEFORE INSERT ON "billing_credit_usage_settlement_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_settlement_adjustment_apply"();

CREATE FUNCTION "billing_credit_usage_allocation_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  adjustment_row "billing_credit_usage_settlement_adjustments"%ROWTYPE;
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  credit_row "billing_credit_accounts"%ROWTYPE;
  previous_row "billing_credit_usage_allocations"%ROWTYPE;
BEGIN
  SELECT * INTO adjustment_row
  FROM "billing_credit_usage_settlement_adjustments"
  WHERE "id" = NEW."adjustment_id";
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR KEY SHARE;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = settlement_row."credit_account_id";
  IF adjustment_row."settlement_id" IS DISTINCT FROM NEW."settlement_id"
     OR adjustment_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR adjustment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR settlement_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR settlement_row."app_key_id" IS DISTINCT FROM NEW."app_key_id" THEN
    RAISE EXCEPTION 'usage allocation does not match its aggregate adjustment'
      USING ERRCODE = '23514';
  END IF;
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF NEW."attributed_user_id" IS NOT NULL THEN
    PERFORM "billing_assert_credit_team_user"(
      credit_row."team_id", NEW."attributed_user_id", false
    );
  END IF;

  SELECT allocation.* INTO previous_row
  FROM "billing_credit_usage_allocations" AS allocation
  JOIN "billing_credit_usage_settlement_adjustments" AS adjustment
    ON adjustment."id" = allocation."adjustment_id"
  WHERE allocation."settlement_id" = NEW."settlement_id"
    AND allocation."adjustment_id" <> NEW."adjustment_id"
    AND allocation."attributed_user_id" IS NOT DISTINCT FROM NEW."attributed_user_id"
    AND adjustment."sequence" < adjustment_row."sequence"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;

  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_rated_usage_amount_micro_minor", 0)
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> COALESCE(previous_row."cumulative_credits_consumed_microcredits", 0)
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_remaining_usage_amount_micro_minor", 0)
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'usage allocation does not continue its per-user cumulative chain'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_usage_allocations_coherence"
  BEFORE INSERT ON "billing_credit_usage_allocations"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_usage_allocation_coherence"();

CREATE FUNCTION "billing_credit_usage_allocation_totals"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  adjustment_id_value TEXT;
  adjustment_row "billing_credit_usage_settlement_adjustments"%ROWTYPE;
  delta_rated NUMERIC;
  delta_credits NUMERIC;
  delta_remaining NUMERIC;
  cumulative_rated NUMERIC;
  cumulative_credits NUMERIC;
  cumulative_remaining NUMERIC;
BEGIN
  adjustment_id_value := COALESCE(
    to_jsonb(NEW) ->> 'adjustment_id',
    to_jsonb(NEW) ->> 'id'
  );
  SELECT * INTO adjustment_row
  FROM "billing_credit_usage_settlement_adjustments"
  WHERE "id" = adjustment_id_value;
  SELECT
    COALESCE(sum("delta_rated_usage_amount_micro_minor"), 0),
    COALESCE(sum("delta_credits_consumed_microcredits"), 0),
    COALESCE(sum("delta_remaining_usage_amount_micro_minor"), 0)
  INTO delta_rated, delta_credits, delta_remaining
  FROM "billing_credit_usage_allocations"
  WHERE "adjustment_id" = adjustment_id_value;
  SELECT
    COALESCE(sum(latest."cumulative_rated_usage_amount_micro_minor"), 0),
    COALESCE(sum(latest."cumulative_credits_consumed_microcredits"), 0),
    COALESCE(sum(latest."cumulative_remaining_usage_amount_micro_minor"), 0)
  INTO cumulative_rated, cumulative_credits, cumulative_remaining
  FROM (
    SELECT DISTINCT ON (allocation."attributed_user_id")
      allocation."cumulative_rated_usage_amount_micro_minor",
      allocation."cumulative_credits_consumed_microcredits",
      allocation."cumulative_remaining_usage_amount_micro_minor"
    FROM "billing_credit_usage_allocations" AS allocation
    JOIN "billing_credit_usage_settlement_adjustments" AS adjustment
      ON adjustment."id" = allocation."adjustment_id"
    WHERE allocation."settlement_id" = adjustment_row."settlement_id"
      AND adjustment."sequence" <= adjustment_row."sequence"
    ORDER BY allocation."attributed_user_id" NULLS FIRST, adjustment."sequence" DESC
  ) AS latest;
  IF delta_rated <> adjustment_row."delta_rated_usage_amount_micro_minor"
     OR delta_credits <> adjustment_row."delta_credits_consumed_microcredits"
     OR delta_remaining <> adjustment_row."delta_remaining_usage_amount_micro_minor"
     OR cumulative_rated <> adjustment_row."cumulative_rated_usage_amount_micro_minor"
     OR cumulative_credits <> adjustment_row."cumulative_credits_consumed_microcredits"
     OR cumulative_remaining <> adjustment_row."cumulative_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'usage allocation totals must equal the aggregate settlement adjustment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "billing_credit_adjustments_require_exact_allocations"
  AFTER INSERT ON "billing_credit_usage_settlement_adjustments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_usage_allocation_totals"();
CREATE CONSTRAINT TRIGGER "billing_credit_allocations_require_exact_totals"
  AFTER INSERT ON "billing_credit_usage_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_usage_allocation_totals"();

CREATE FUNCTION "billing_credit_invoice_line_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  adjustment_row "billing_credit_usage_settlement_adjustments"%ROWTYPE;
  subscription_row "billing_stripe_subscriptions"%ROWTYPE;
BEGIN
  SELECT * INTO settlement_row FROM "billing_credit_usage_settlements"
    WHERE "id" = NEW."settlement_id";
  SELECT * INTO adjustment_row FROM "billing_credit_usage_settlement_adjustments"
    WHERE "id" = NEW."last_adjustment_id";
  SELECT * INTO subscription_row FROM "billing_stripe_subscriptions"
    WHERE "id" = NEW."subscription_id";
  IF settlement_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR settlement_row."subscription_id" IS DISTINCT FROM NEW."subscription_id"
     OR adjustment_row."settlement_id" IS DISTINCT FROM NEW."settlement_id"
     OR adjustment_row."cumulative_credits_consumed_microcredits"
       IS DISTINCT FROM NEW."cumulative_credits_consumed_microcredits"
     OR EXISTS (
       SELECT 1 FROM "billing_credit_usage_settlement_adjustments" AS newer
       WHERE newer."settlement_id" = NEW."settlement_id"
         AND newer."sequence" > adjustment_row."sequence"
     )
     OR subscription_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR subscription_row."id" IS DISTINCT FROM settlement_row."subscription_id" THEN
    RAISE EXCEPTION 'Stripe credit line must project the latest exact settlement cumulative'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_invoice_lines_coherence"
  BEFORE INSERT OR UPDATE ON "billing_credit_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_invoice_line_coherence"();

CREATE FUNCTION "billing_credit_adjustment_invoice_line_current"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "billing_credit_invoice_lines" AS line
    WHERE line."settlement_id" = NEW."settlement_id"
      AND line."last_adjustment_id" IS DISTINCT FROM NEW."id"
      AND line."status" NOT IN ('REMOVED', 'NEEDS_REVIEW')
  ) THEN
    RAISE EXCEPTION 'existing Stripe credit line must advance or enter review with its settlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "billing_credit_adjustments_keep_invoice_line_current"
  AFTER INSERT ON "billing_credit_usage_settlement_adjustments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_adjustment_invoice_line_current"();

CREATE TRIGGER "billing_recurring_addon_feature_policies_immutable_terms"
  BEFORE UPDATE OR DELETE ON "billing_recurring_addon_feature_policies"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_versioned_terms"();

CREATE FUNCTION "billing_recurring_addon_feature_policy_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offer_service_id TEXT;
BEGIN
  SELECT "service_id" INTO offer_service_id
  FROM "billing_recurring_addon_offers" WHERE "id" = NEW."offer_id";
  IF offer_service_id IS DISTINCT FROM NEW."service_id" THEN
    RAISE EXCEPTION 'recurring add-on feature policy service does not match its offer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_recurring_addon_feature_policies_coherence"
  BEFORE INSERT OR UPDATE ON "billing_recurring_addon_feature_policies"
  FOR EACH ROW EXECUTE FUNCTION "billing_recurring_addon_feature_policy_coherence"();

CREATE FUNCTION "billing_recurring_addon_catalog_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offer_row "billing_recurring_addon_offers"%ROWTYPE;
BEGIN
  SELECT * INTO offer_row FROM "billing_recurring_addon_offers"
    WHERE "id" = NEW."offer_id";
  IF offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."currency" IS DISTINCT FROM NEW."currency"
     OR offer_row."monthly_amount_minor" IS DISTINCT FROM NEW."monthly_amount_minor" THEN
    RAISE EXCEPTION 'recurring add-on catalog does not match its immutable offer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_recurring_addon_catalogs_coherence"
  BEFORE INSERT OR UPDATE ON "billing_recurring_addon_catalogs"
  FOR EACH ROW EXECUTE FUNCTION "billing_recurring_addon_catalog_coherence"();

CREATE FUNCTION "billing_recurring_addon_checkout_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  customer_row "billing_stripe_customers"%ROWTYPE;
  catalog_row "billing_recurring_addon_catalogs"%ROWTYPE;
  offer_row "billing_recurring_addon_offers"%ROWTYPE;
  completion_event_row "billing_stripe_webhook_events"%ROWTYPE;
  team_org_id TEXT;
  requester_is_manager BOOLEAN;
  account_livemode BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."account_id" || ':' || NEW."service_id" || ':' || NEW."offer_key"
      || ':' || NEW."scope"::text || ':' || NEW."scope_key",
    0
  ));
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'CREATING'
    OR NEW."stripe_checkout_session_id" IS NOT NULL
    OR NEW."stripe_subscription_id" IS NOT NULL
    OR NEW."completion_webhook_event_id" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new recurring add-on checkout must begin creating without proof'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETE' THEN
    IF ROW(
      NEW."status", NEW."stripe_checkout_session_id", NEW."stripe_subscription_id",
      NEW."completion_webhook_event_id", NEW."completed_at"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."stripe_checkout_session_id", OLD."stripe_subscription_id",
      OLD."completion_webhook_event_id", OLD."completed_at"
    ) THEN
      RAISE EXCEPTION 'completed recurring add-on checkout proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO catalog_row FROM "billing_recurring_addon_catalogs"
    WHERE "id" = NEW."catalog_id";
  SELECT * INTO offer_row FROM "billing_recurring_addon_offers"
    WHERE "id" = NEW."offer_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
    IF NOT EXISTS (
      SELECT 1
      FROM "org_members" AS member
      WHERE member."org_id" = NEW."org_id"
        AND member."user_id" = NEW."requested_by_user_id"
        AND member."status" = 'ACTIVE'
    ) OR NOT EXISTS (
      SELECT 1
      FROM "teams" AS team
      JOIN "team_members" AS member ON member."team_id" = team."id"
      WHERE team."id" = NEW."requested_team_id"
        AND team."org_id" = NEW."org_id"
        AND member."user_id" = NEW."requested_by_user_id"
        AND member."status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'recurring add-on checkout actor tenancy is inactive'
        USING ERRCODE = '23514';
    END IF;
    SELECT (
      EXISTS (
        SELECT 1 FROM "organisations" AS organisation
        WHERE organisation."id" = NEW."org_id"
          AND organisation."owner_id" = NEW."requested_by_user_id"
      )
      OR EXISTS (
        SELECT 1 FROM "org_members" AS member
        WHERE member."org_id" = NEW."org_id"
          AND member."user_id" = NEW."requested_by_user_id"
          AND member."status" = 'ACTIVE'
          AND member."role" IN ('owner', 'admin')
      )
      OR (
        NEW."scope" <> 'ORGANISATION'
        AND EXISTS (
          SELECT 1 FROM "team_members" AS member
          WHERE member."team_id" = NEW."requested_team_id"
            AND member."user_id" = NEW."requested_by_user_id"
            AND member."status" = 'ACTIVE'
            AND member."team_role" IN ('owner', 'admin')
        )
      )
    ) INTO requester_is_manager;
    IF NOT requester_is_manager THEN
      RAISE EXCEPTION 'recurring add-on checkout requires a billing manager'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."scope" IN ('TEAM', 'SUBSCRIBING_USER') THEN
    SELECT "org_id" INTO team_org_id FROM "teams" WHERE "id" = NEW."team_id";
    IF team_org_id IS DISTINCT FROM NEW."org_id"
       OR NEW."requested_team_id" IS DISTINCT FROM NEW."team_id" THEN
      RAISE EXCEPTION 'recurring add-on team does not belong to the organisation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."scope" = 'SUBSCRIBING_USER' THEN
      IF NEW."subscribing_user_id" IS DISTINCT FROM NEW."requested_by_user_id" THEN
        RAISE EXCEPTION 'user-scoped add-on checkout must belong to the authenticated subscriber'
          USING ERRCODE = '23514';
      END IF;
      PERFORM "billing_assert_credit_team_user"(
        NEW."team_id", NEW."subscribing_user_id", true
      );
    END IF;
  END IF;

  IF length(btrim(NEW."actor_jti")) = 0
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR (
       NEW."scope" = 'ORGANISATION'
       AND (customer_row."scope" IS DISTINCT FROM 'ORGANISATION' OR customer_row."team_id" IS NOT NULL)
     )
     OR (
       NEW."scope" IN ('TEAM', 'SUBSCRIBING_USER')
       AND (customer_row."scope" IS DISTINCT FROM 'TEAM' OR customer_row."team_id" IS DISTINCT FROM NEW."team_id")
     )
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR catalog_row."offer_id" IS DISTINCT FROM NEW."offer_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."key" IS DISTINCT FROM NEW."offer_key"
     OR EXISTS (
       SELECT 1 FROM "billing_recurring_addon_subscriptions" AS subscription
       WHERE subscription."account_id" = NEW."account_id"
         AND subscription."service_id" = NEW."service_id"
         AND subscription."offer_key" = NEW."offer_key"
         AND subscription."scope" = NEW."scope"
         AND subscription."scope_key" = NEW."scope_key"
         AND subscription."status" NOT IN ('canceled', 'incomplete_expired')
     )
     OR (
       TG_OP = 'INSERT'
       AND (catalog_row."stripe_price_id" IS NULL OR NOT offer_row."active")
     ) THEN
    RAISE EXCEPTION 'recurring add-on checkout binding is incoherent'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'COMPLETE' THEN
    SELECT * INTO completion_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."completion_webhook_event_id";
    IF completion_event_row."id" IS NULL
       OR completion_event_row."type" IS DISTINCT FROM 'checkout.session.completed'
       OR completion_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR completion_event_row."livemode" IS DISTINCT FROM account_livemode
       OR completion_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_checkout_session_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR completion_event_row."stripe_subscription_id" IS DISTINCT FROM NEW."stripe_subscription_id"
       OR completion_event_row."stripe_created_at" IS DISTINCT FROM NEW."completed_at" THEN
      RAISE EXCEPTION 'completed recurring add-on checkout lacks exact Stripe evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_recurring_addon_checkouts_coherence"
  BEFORE INSERT OR UPDATE ON "billing_recurring_addon_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_recurring_addon_checkout_coherence"();

CREATE FUNCTION "billing_recurring_addon_subscription_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  checkout_row "billing_recurring_addon_checkouts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  catalog_row "billing_recurring_addon_catalogs"%ROWTYPE;
  activation_event_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."account_id" || ':' || NEW."service_id" || ':' || NEW."offer_key"
      || ':' || NEW."scope"::text || ':' || NEW."scope_key",
    0
  ));
  SELECT * INTO checkout_row FROM "billing_recurring_addon_checkouts"
    WHERE "id" = NEW."checkout_id";
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO catalog_row FROM "billing_recurring_addon_catalogs"
    WHERE "id" = NEW."catalog_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  IF checkout_row."status" IS DISTINCT FROM 'COMPLETE'
     OR checkout_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR checkout_row."customer_id" IS DISTINCT FROM NEW."customer_id"
     OR checkout_row."catalog_id" IS DISTINCT FROM NEW."catalog_id"
     OR checkout_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR checkout_row."offer_id" IS DISTINCT FROM NEW."offer_id"
     OR checkout_row."offer_key" IS DISTINCT FROM NEW."offer_key"
     OR checkout_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR checkout_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR checkout_row."subscribing_user_id" IS DISTINCT FROM NEW."subscribing_user_id"
     OR checkout_row."scope" IS DISTINCT FROM NEW."scope"
     OR checkout_row."scope_key" IS DISTINCT FROM NEW."scope_key"
     OR checkout_row."stripe_subscription_id" IS DISTINCT FROM NEW."stripe_subscription_id"
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR catalog_row."offer_id" IS DISTINCT FROM NEW."offer_id"
     OR account_livemode IS DISTINCT FROM NEW."livemode"
     OR EXISTS (
       SELECT 1 FROM "billing_stripe_subscriptions" AS base
       WHERE base."account_id" = NEW."account_id"
         AND (
           base."stripe_subscription_id" = NEW."stripe_subscription_id"
           OR base."stripe_monthly_item_id" = NEW."stripe_item_id"
           OR base."stripe_usage_item_id" = NEW."stripe_item_id"
         )
     ) THEN
    RAISE EXCEPTION 'recurring add-on must be a distinct one-item paid subscription'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."entitlement_activated_at" IS NOT NULL
     AND (
       NEW."initial_invoice_paid_at" IS NULL
       OR NEW."entitlement_activated_at" < NEW."initial_invoice_paid_at"
     ) THEN
    RAISE EXCEPTION 'recurring add-on entitlement requires verified initial payment'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."entitlement_activated_at" IS NOT NULL THEN
    SELECT * INTO activation_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."activation_webhook_event_id";
    IF activation_event_row."id" IS NULL
       OR activation_event_row."type" IS DISTINCT FROM 'invoice.paid'
       OR activation_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR activation_event_row."livemode" IS DISTINCT FROM NEW."livemode"
       OR activation_event_row."stripe_object_id" IS DISTINCT FROM NEW."initial_invoice_id"
       OR activation_event_row."stripe_invoice_id" IS DISTINCT FROM NEW."initial_invoice_id"
       OR activation_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR activation_event_row."stripe_subscription_id" IS DISTINCT FROM NEW."stripe_subscription_id"
       OR activation_event_row."stripe_subscription_item_id" IS DISTINCT FROM NEW."stripe_item_id"
       OR activation_event_row."amount_minor" IS DISTINCT FROM catalog_row."monthly_amount_minor"
       OR activation_event_row."currency" IS DISTINCT FROM catalog_row."currency"
       OR activation_event_row."stripe_created_at" IS DISTINCT FROM NEW."initial_invoice_paid_at" THEN
      RAISE EXCEPTION 'recurring add-on entitlement lacks exact paid invoice evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."entitlement_deactivated_at" IS NOT NULL
     AND NEW."status" IN ('active', 'trialing') THEN
    RAISE EXCEPTION 'deactivated recurring add-on entitlement cannot be active'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" IN ('canceled', 'incomplete_expired')
       AND ROW(
         NEW."status", NEW."initial_invoice_paid_at",
         NEW."entitlement_activated_at", NEW."entitlement_deactivated_at"
       ) IS DISTINCT FROM ROW(
         OLD."status", OLD."initial_invoice_paid_at",
         OLD."entitlement_activated_at", OLD."entitlement_deactivated_at"
       ) THEN
      RAISE EXCEPTION 'terminal recurring add-on subscriptions cannot be resurrected'
        USING ERRCODE = '23514';
    END IF;
    IF OLD."initial_invoice_paid_at" IS NOT NULL
       AND ROW(
         NEW."initial_invoice_paid_at", NEW."initial_invoice_id", NEW."activation_webhook_event_id"
       ) IS DISTINCT FROM ROW(
         OLD."initial_invoice_paid_at", OLD."initial_invoice_id", OLD."activation_webhook_event_id"
       ) THEN
      RAISE EXCEPTION 'recurring add-on initial payment proof is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD."entitlement_activated_at" IS NOT NULL
       AND NEW."entitlement_activated_at" IS DISTINCT FROM OLD."entitlement_activated_at" THEN
      RAISE EXCEPTION 'recurring add-on activation proof is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD."entitlement_deactivated_at" IS NOT NULL
       AND NEW."entitlement_deactivated_at" IS DISTINCT FROM OLD."entitlement_deactivated_at" THEN
      RAISE EXCEPTION 'recurring add-on deactivation proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_recurring_addon_subscriptions_coherence"
  BEFORE INSERT OR UPDATE ON "billing_recurring_addon_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "billing_recurring_addon_subscription_coherence"();

CREATE FUNCTION "billing_recurring_addon_cancellation_intent_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subscription_row "billing_recurring_addon_subscriptions"%ROWTYPE;
  requester_is_manager BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'billing-recurring-addon-cancel:' || NEW."subscription_id",
    0
  ));
  SELECT * INTO subscription_row
  FROM "billing_recurring_addon_subscriptions"
  WHERE "id" = NEW."subscription_id"
  FOR SHARE;

  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
  END IF;

  IF subscription_row."id" IS NULL
     OR subscription_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR subscription_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR subscription_row."offer_id" IS DISTINCT FROM NEW."offer_id"
     OR subscription_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR subscription_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR subscription_row."subscribing_user_id" IS DISTINCT FROM NEW."subscribing_user_id"
     OR subscription_row."scope" IS DISTINCT FROM NEW."scope"
     OR subscription_row."scope_key" IS DISTINCT FROM NEW."scope_key"
     OR length(btrim(NEW."actor_jti")) = 0 THEN
    RAISE EXCEPTION 'recurring add-on cancellation intent binding is incoherent'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "org_members" AS member
      WHERE member."org_id" = NEW."org_id"
        AND member."user_id" = NEW."requested_by_user_id"
        AND member."status" = 'ACTIVE'
    ) OR NOT EXISTS (
      SELECT 1
      FROM "teams" AS team
      JOIN "team_members" AS member
        ON member."team_id" = team."id"
      WHERE team."id" = NEW."requested_team_id"
        AND team."org_id" = NEW."org_id"
        AND member."user_id" = NEW."requested_by_user_id"
        AND member."status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'recurring add-on cancellation actor tenancy is inactive'
        USING ERRCODE = '23514';
    END IF;

    SELECT (
      EXISTS (
        SELECT 1
        FROM "organisations" AS organisation
        WHERE organisation."id" = NEW."org_id"
          AND organisation."owner_id" = NEW."requested_by_user_id"
      )
      OR EXISTS (
        SELECT 1
        FROM "org_members" AS member
        WHERE member."org_id" = NEW."org_id"
          AND member."user_id" = NEW."requested_by_user_id"
          AND member."status" = 'ACTIVE'
          AND member."role" IN ('owner', 'admin')
      )
      OR (
        NEW."scope" <> 'ORGANISATION'
        AND
        EXISTS (
          SELECT 1
          FROM "team_members" AS member
          WHERE member."team_id" = NEW."requested_team_id"
            AND member."user_id" = NEW."requested_by_user_id"
            AND member."status" = 'ACTIVE'
            AND member."team_role" IN ('owner', 'admin')
        )
      )
    ) INTO requester_is_manager;

    IF NOT requester_is_manager
       OR NEW."state" IS DISTINCT FROM 'AVAILABLE'
       OR NEW."confirmation_request_digest" IS NOT NULL
       OR NEW."result" IS NOT NULL
       OR NEW."consumed_at" IS NOT NULL
       OR NEW."expires_at" <= CURRENT_TIMESTAMP
       OR subscription_row."status" IN ('canceled', 'incomplete_expired')
       OR subscription_row."cancel_at_period_end" THEN
      RAISE EXCEPTION 'new recurring add-on cancellation intent is not available'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD."state" = 'AVAILABLE' THEN
      IF NEW."state" NOT IN ('AVAILABLE', 'PROCESSING', 'EXPIRED') THEN
        RAISE EXCEPTION 'recurring add-on cancellation intent transition is invalid'
          USING ERRCODE = '23514';
      END IF;
      IF NEW."state" = 'PROCESSING' AND OLD."expires_at" <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'recurring add-on cancellation intent has expired'
          USING ERRCODE = '23514';
      END IF;
      IF NEW."state" = 'EXPIRED' AND OLD."expires_at" > CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'recurring add-on cancellation intent is not expired'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."state" = 'PROCESSING' THEN
      IF NEW."state" NOT IN ('PROCESSING', 'COMPLETED')
         OR NEW."confirmation_request_digest"
            IS DISTINCT FROM OLD."confirmation_request_digest" THEN
        RAISE EXCEPTION 'recurring add-on cancellation processing proof is immutable'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."state" IN ('COMPLETED', 'EXPIRED') AND ROW(
      NEW."state", NEW."confirmation_request_digest", NEW."result", NEW."consumed_at"
    ) IS DISTINCT FROM ROW(
      OLD."state", OLD."confirmation_request_digest", OLD."result", OLD."consumed_at"
    ) THEN
      RAISE EXCEPTION 'completed recurring add-on cancellation proof is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."state" = 'COMPLETED'
       AND NOT (
         subscription_row."cancel_at_period_end"
         OR subscription_row."status" = 'canceled'
       ) THEN
      RAISE EXCEPTION 'completed cancellation requires the bound subscription to be canceled'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_recurring_addon_cancel_intents_coherence"
  BEFORE INSERT OR UPDATE ON "billing_recurring_addon_cancellation_intents"
  FOR EACH ROW EXECUTE FUNCTION "billing_recurring_addon_cancellation_intent_coherence"();

CREATE FUNCTION "billing_recurring_addon_cancellation_intent_identity_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_identity JSONB;
  old_identity JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recurring add-on cancellation history cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  new_identity := to_jsonb(NEW) - ARRAY[
    'state', 'confirmation_request_digest', 'result', 'consumed_at', 'updated_at'
  ];
  old_identity := to_jsonb(OLD) - ARRAY[
    'state', 'confirmation_request_digest', 'result', 'consumed_at', 'updated_at'
  ];
  IF new_identity IS DISTINCT FROM old_identity THEN
    RAISE EXCEPTION 'recurring add-on cancellation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_recurring_addon_cancel_intents_immutable"
  BEFORE UPDATE OR DELETE ON "billing_recurring_addon_cancellation_intents"
  FOR EACH ROW EXECUTE FUNCTION "billing_recurring_addon_cancellation_intent_identity_guard"();

CREATE FUNCTION "billing_guard_funding_projection_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_identity JSONB;
  old_identity JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% commercial history cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'billing_credit_accounts' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'balance_microcredits', 'auto_top_up_state', 'auto_top_up_policy_id',
        'auto_top_up_service_id', 'auto_top_up_app_key_id',
        'auto_top_up_consent_revision_id', 'auto_top_up_option_id',
        'auto_top_up_threshold_microcredits', 'auto_top_up_refill_offer_id',
        'auto_top_up_monthly_charge_cap_minor', 'auto_top_up_consent_version',
        'auto_top_up_consented_at', 'auto_top_up_consented_by_user_id',
        'stripe_payment_method_id', 'payment_method_summary', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'balance_microcredits', 'auto_top_up_state', 'auto_top_up_policy_id',
        'auto_top_up_service_id', 'auto_top_up_app_key_id',
        'auto_top_up_consent_revision_id', 'auto_top_up_option_id',
        'auto_top_up_threshold_microcredits', 'auto_top_up_refill_offer_id',
        'auto_top_up_monthly_charge_cap_minor', 'auto_top_up_consent_version',
        'auto_top_up_consented_at', 'auto_top_up_consented_by_user_id',
        'stripe_payment_method_id', 'payment_method_summary', 'updated_at'
      ];
    WHEN 'billing_credit_top_up_checkouts' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'stripe_checkout_session_id', 'stripe_payment_intent_id',
        'completion_webhook_event_id', 'status',
        'lease_expires_at', 'expires_at', 'completed_at', 'credit_entry_id', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'stripe_checkout_session_id', 'stripe_payment_intent_id',
        'completion_webhook_event_id', 'status',
        'lease_expires_at', 'expires_at', 'completed_at', 'credit_entry_id', 'updated_at'
      ];
    WHEN 'billing_credit_setup_checkouts' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'stripe_checkout_session_id', 'stripe_setup_intent_id',
        'stripe_payment_method_id', 'completion_webhook_event_id', 'status',
        'lease_expires_at', 'expires_at', 'completed_at', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'stripe_checkout_session_id', 'stripe_setup_intent_id',
        'stripe_payment_method_id', 'completion_webhook_event_id', 'status',
        'lease_expires_at', 'expires_at', 'completed_at', 'updated_at'
      ];
    WHEN 'billing_credit_auto_top_up_attempts' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'stripe_payment_intent_id', 'success_webhook_event_id', 'status', 'failure_code',
        'credit_entry_id', 'resolved_at', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'stripe_payment_intent_id', 'success_webhook_event_id', 'status', 'failure_code',
        'credit_entry_id', 'resolved_at', 'updated_at'
      ];
    WHEN 'billing_credit_usage_settlements' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'subscription_id', 'cumulative_rated_usage_amount_micro_minor',
        'cumulative_credits_consumed_microcredits',
        'cumulative_remaining_usage_amount_micro_minor', 'status', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'subscription_id', 'cumulative_rated_usage_amount_micro_minor',
        'cumulative_credits_consumed_microcredits',
        'cumulative_remaining_usage_amount_micro_minor', 'status', 'updated_at'
      ];
    WHEN 'billing_credit_invoice_lines' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'last_adjustment_id', 'stripe_invoice_item_id',
        'cumulative_credits_consumed_microcredits', 'stripe_unit_amount_decimal',
        'stripe_quantity', 'status', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'last_adjustment_id', 'stripe_invoice_item_id',
        'cumulative_credits_consumed_microcredits', 'stripe_unit_amount_decimal',
        'stripe_quantity', 'status', 'updated_at'
      ];
    WHEN 'billing_recurring_addon_checkouts' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'stripe_checkout_session_id', 'stripe_subscription_id',
        'completion_webhook_event_id', 'status', 'lease_expires_at',
        'expires_at', 'completed_at', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'stripe_checkout_session_id', 'stripe_subscription_id',
        'completion_webhook_event_id', 'status', 'lease_expires_at',
        'expires_at', 'completed_at', 'updated_at'
      ];
    WHEN 'billing_recurring_addon_subscriptions' THEN
      new_identity := to_jsonb(NEW) - ARRAY[
        'status', 'cancel_at_period_end', 'current_period_start', 'current_period_end',
        'initial_invoice_paid_at', 'initial_invoice_id', 'activation_webhook_event_id',
        'entitlement_activated_at',
        'entitlement_deactivated_at', 'updated_at'
      ];
      old_identity := to_jsonb(OLD) - ARRAY[
        'status', 'cancel_at_period_end', 'current_period_start', 'current_period_end',
        'initial_invoice_paid_at', 'initial_invoice_id', 'activation_webhook_event_id',
        'entitlement_activated_at',
        'entitlement_deactivated_at', 'updated_at'
      ];
    ELSE
      RAISE EXCEPTION 'unsupported commercial projection table %', TG_TABLE_NAME
        USING ERRCODE = '23514';
  END CASE;
  IF new_identity IS DISTINCT FROM old_identity THEN
    RAISE EXCEPTION '% identity and commercial snapshot are immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_accounts_immutable_identity"
  BEFORE UPDATE OR DELETE ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_credit_top_up_checkouts_immutable_snapshot"
  BEFORE UPDATE OR DELETE ON "billing_credit_top_up_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_credit_setup_checkouts_immutable_snapshot"
  BEFORE UPDATE OR DELETE ON "billing_credit_setup_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_credit_auto_top_up_attempts_immutable_snapshot"
  BEFORE UPDATE OR DELETE ON "billing_credit_auto_top_up_attempts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_credit_usage_settlements_immutable_identity"
  BEFORE UPDATE OR DELETE ON "billing_credit_usage_settlements"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_credit_invoice_lines_immutable_identity"
  BEFORE UPDATE OR DELETE ON "billing_credit_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_recurring_addon_checkouts_immutable_snapshot"
  BEFORE UPDATE OR DELETE ON "billing_recurring_addon_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();
CREATE TRIGGER "billing_recurring_addon_subscriptions_immutable_identity"
  BEFORE UPDATE OR DELETE ON "billing_recurring_addon_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();

-- All credit quantities participating in commercial settlement have an exact
-- USD micro-minor inverse: 10 microcredits = one USD micro-minor.
ALTER TABLE "billing_credit_auto_top_up_options"
  ADD CONSTRAINT "billing_credit_auto_top_up_options_exact_unit_check"
    CHECK ("threshold_microcredits" % 10 = 0);
ALTER TABLE "billing_credit_accounts"
  ADD CONSTRAINT "billing_credit_accounts_exact_unit_check" CHECK (
    "balance_microcredits" % 10 = 0
    AND (
      "auto_top_up_threshold_microcredits" IS NULL
      OR "auto_top_up_threshold_microcredits" % 10 = 0
    )
  );
ALTER TABLE "billing_credit_entries"
  ADD CONSTRAINT "billing_credit_entries_exact_unit_check" CHECK (
    "amount_microcredits" % 10 = 0
    AND "balance_after_microcredits" % 10 = 0
  );
ALTER TABLE "billing_credit_setup_checkouts"
  ADD CONSTRAINT "billing_credit_setup_checkouts_exact_unit_check" CHECK (
    "threshold_microcredits" % 10 = 0
    AND "refill_credits_microcredits" % 10 = 0
  );
ALTER TABLE "billing_credit_auto_top_up_attempts"
  ADD CONSTRAINT "billing_credit_auto_top_up_attempts_exact_unit_check" CHECK (
    "threshold_microcredits" % 10 = 0
    AND "observed_balance_microcredits" % 10 = 0
    AND "credits_received_microcredits" % 10 = 0
  );
ALTER TABLE "billing_credit_usage_settlements"
  ADD CONSTRAINT "billing_credit_usage_settlements_exact_unit_check"
    CHECK ("cumulative_credits_consumed_microcredits" % 10 = 0);
ALTER TABLE "billing_credit_usage_settlement_adjustments"
  ADD CONSTRAINT "billing_credit_usage_adjustments_exact_unit_check" CHECK (
    "delta_credits_consumed_microcredits" % 10 = 0
    AND "cumulative_credits_consumed_microcredits" % 10 = 0
  );
ALTER TABLE "billing_credit_usage_allocations"
  ADD CONSTRAINT "billing_credit_usage_allocations_exact_unit_check" CHECK (
    "delta_credits_consumed_microcredits" % 10 = 0
    AND "cumulative_credits_consumed_microcredits" % 10 = 0
  );
ALTER TABLE "billing_credit_invoice_lines"
  ADD CONSTRAINT "billing_credit_invoice_lines_exact_unit_check"
    CHECK ("cumulative_credits_consumed_microcredits" % 10 = 0);

-- Commercial billing internals are inaccessible to the ordinary UOA app role.
-- Only the dedicated admin role receives table privileges; product access is
-- exclusively through authenticated UOA billing APIs.
DO $$
DECLARE
  table_name TEXT;
  protected_tables TEXT[] := ARRAY[
    'billing_credit_funding_policies',
    'billing_credit_top_up_offers',
    'billing_credit_auto_top_up_options',
    'billing_credit_top_up_catalogs',
    'billing_credit_accounts',
    'billing_credit_entries',
    'billing_credit_admin_adjustments',
    'billing_credit_payment_adjustments',
    'billing_credit_portfolio_snapshots',
    'billing_credit_auto_top_up_consent_revisions',
    'billing_credit_top_up_checkouts',
    'billing_credit_setup_checkouts',
    'billing_credit_auto_top_up_attempts',
    'billing_credit_usage_settlements',
    'billing_credit_usage_settlement_adjustments',
    'billing_credit_usage_allocations',
    'billing_credit_invoice_lines',
    'billing_recurring_addon_offers',
    'billing_recurring_addon_feature_policies',
    'billing_recurring_addon_catalogs',
    'billing_recurring_addon_checkouts',
    'billing_recurring_addon_subscriptions',
    'billing_recurring_addon_cancellation_intents'
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_app') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM uoa_app', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_admin') THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO uoa_admin',
        table_name
      );
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_app') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO uoa_app USING (false) WITH CHECK (false)',
        table_name || '_deny_app',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
