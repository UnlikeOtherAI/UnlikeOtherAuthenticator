import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

/** Diagnose only the exact invoice/subscription customer's payment method, never infer a decline. */
export async function seatRenewalPaymentReason(invoice: Stripe.Invoice, stripeSubscriptionId: string,
  actionRequired: boolean, stripe: Pick<Stripe, 'subscriptions' | 'paymentMethods'>, now = new Date()) {
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
    expand: ['default_payment_method', 'customer.invoice_settings.default_payment_method'],
  });
  const customerId = stripeExternalId(invoice.customer);
  if (subscription.id !== stripeSubscriptionId || subscription.livemode !== invoice.livemode ||
    stripeExternalId(subscription.customer) !== customerId) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_RENEWAL_SOURCE_DRIFT');
  }
  const customer = typeof subscription.customer === 'object' && !subscription.customer.deleted ? subscription.customer : null;
  const source = invoice.default_payment_method ?? subscription.default_payment_method ?? customer?.invoice_settings.default_payment_method;
  const method = typeof source === 'string' ? await stripe.paymentMethods.retrieve(source) : source;
  if (method && (method.livemode !== invoice.livemode || stripeExternalId(method.customer) !== customerId)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_METHOD_BINDING_UNPROVEN');
  }
  if (method?.type === 'card' && method.card && (method.card.exp_year < now.getUTCFullYear() ||
    method.card.exp_year === now.getUTCFullYear() && method.card.exp_month < now.getUTCMonth() + 1)) return 'card_expired' as const;
  return actionRequired ? 'payment_action_required' as const : 'payment_required' as const;
}
