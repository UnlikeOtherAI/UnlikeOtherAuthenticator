import type { Prisma } from '@prisma/client';
import type Stripe from 'stripe';

export function creditPaymentMethodSummary(method: Stripe.PaymentMethod): Prisma.InputJsonValue {
  if (!method.card) return { type: method.type };
  return {
    type: 'card',
    brand: method.card.brand,
    last4: method.card.last4,
    exp_month: method.card.exp_month,
    exp_year: method.card.exp_year,
  };
}
