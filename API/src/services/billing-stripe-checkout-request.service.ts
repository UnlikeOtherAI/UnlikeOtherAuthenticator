import type { BillingTariff, BillingStripeCheckoutSession } from '@prisma/client';
import type Stripe from 'stripe';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeCheckoutLocale } from './billing-stripe-locale.js';
import { AppError } from '../utils/errors.js';

/** One request constructor for both assigned agreements and explicit published seats. */
export function baseStripeCheckoutRequest(input: {
  checkout: BillingStripeCheckoutSession; tariff: BillingTariff; account: StripeAccountContext;
  customerId: string; successUrl: string; cancelUrl: string; monthlyPriceId: string | null;
  usagePriceId: string; scopeKey: string; now: Date;
}): Stripe.Checkout.SessionCreateParams {
  const { checkout, tariff, account } = input;
  const terms = checkout.seatConsentTerms;
  if (checkout.seatOfferId && (!terms || typeof terms !== 'object' || Array.isArray(terms) || typeof terms.checkout_text !== 'string')) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SEAT_CONSENT_EVIDENCE_REQUIRED');
  }
  return {
    mode: 'subscription', ...stripeCheckoutLocale(checkout.checkoutLocale), customer: input.customerId,
    client_reference_id: checkout.id, success_url: input.successUrl, cancel_url: input.cancelUrl,
    allow_promotion_codes: false, billing_address_collection: 'required', payment_method_collection: 'always',
    ...(terms && typeof terms === 'object' && !Array.isArray(terms) && typeof terms.checkout_text === 'string'
      ? { custom_text: { submit: { message: terms.checkout_text } } } : {}),
    line_items: [...(tariff.monthlyChargeBasis !== 'PER_SEAT' && input.monthlyPriceId
      ? [{ price: input.monthlyPriceId, quantity: 1 }] : []), { price: input.usagePriceId }],
    metadata: { uoa_checkout_id: checkout.id },
    subscription_data: {
      billing_cycle_anchor: Math.floor(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + 1, 1) / 1000),
      proration_behavior: 'none', metadata: {
        uoa_checkout_id: checkout.id, uoa_service_id: checkout.serviceId, uoa_tariff_id: tariff.id,
        uoa_scope_key: input.scopeKey, uoa_stripe_account_id: account.stripeAccountId,
        uoa_stripe_mode: account.livemode ? 'live' : 'test',
        ...(checkout.fixedSeatQuantity === null ? {} : { uoa_fixed_seat_quantity: String(checkout.fixedSeatQuantity) }),
      },
    },
  };
}
