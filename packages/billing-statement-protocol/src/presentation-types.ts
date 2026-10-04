import type { BillingHostedRedirectResponse } from './action-types.js';

/** Explicit presentation negotiation keeps older strict consumers in English. */
export const BILLING_PRESENTATION_VERSION = '1.5.0' as const;
export const BILLING_PRESENTATION_HEADER = 'x-uoa-billing-presentation' as const;
export const BILLING_LOCALE_HEADER = 'x-uoa-billing-locale' as const;
export const BILLING_CUSTOMER_LOCALES = ['cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'] as const;
export type BillingCustomerLocale = (typeof BILLING_CUSTOMER_LOCALES)[number];

export const BILLING_CREDIT_PURCHASE_STATUS_PATH = '/billing/v1/credits/purchase-status' as const;
export const BILLING_CREDIT_PURCHASE_SCHEMA_PATH = '/schemas/billing-credit-purchase-status-v1.json' as const;
export const BILLING_CREDIT_PURCHASE_STATES = [
  'open', 'processing', 'requires_action', 'succeeded', 'failed', 'expired', 'needs_review',
] as const;
export type BillingCreditPurchaseState = (typeof BILLING_CREDIT_PURCHASE_STATES)[number];

/** A read of one authorized purchase; no redirect or balance comparison proves success. */
export type BillingCreditPurchaseStatusV1 = {
  schema_version: 1;
  purchase_id: string;
  state: BillingCreditPurchaseState;
  title: string;
  message: string;
  /** Only a payment already awaiting confirmation warrants bounded automatic reads. */
  awaiting_confirmation: boolean;
  /** The same authorized open Checkout, when Stripe still reports it resumable. */
  continuation?: BillingHostedRedirectResponse;
};
