import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import type { CreditPaymentBinding } from './billing-credit-funding-webhook.types.js';

const PAYMENT_BINDING_KEYS = [
  'uoa_credit_top_up_checkout_id',
  'uoa_credit_auto_top_up_attempt_id',
] as const;

export function paymentBinding(
  metadata: Stripe.Metadata | null | undefined,
): CreditPaymentBinding | null {
  const present = PAYMENT_BINDING_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(metadata ?? {}, key),
  );
  if (present.length === 0) return null;
  const values = present.map((key) => metadata?.[key]?.trim()).filter(Boolean);
  if (present.length !== 1 || values.length !== 1) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_METADATA_INVALID');
  }
  return {
    localId: values[0] as string,
    localType:
      present[0] === 'uoa_credit_top_up_checkout_id' ? 'top_up' : 'automatic_top_up',
  };
}

export function setupBinding(metadata: Stripe.Metadata | null | undefined): string | null {
  if (!Object.prototype.hasOwnProperty.call(metadata ?? {}, 'uoa_credit_setup_checkout_id')) {
    return null;
  }
  const value = metadata?.uoa_credit_setup_checkout_id?.trim();
  if (!value) throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_METADATA_INVALID');
  return value;
}
