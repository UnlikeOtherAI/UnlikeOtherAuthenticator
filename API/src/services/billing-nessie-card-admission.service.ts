import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { resolveCreditCollectionContext, type CreditCollectionContext } from './billing-credit-account.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

/** A funded wallet and billing setup are separate admission requirements. Never charges a card. */
export async function assertNessieCardOnFile(input: { product: string; organisationId: string; teamId: string | null },
  prisma: PrismaClient, deps: { collection?: CreditCollectionContext } = {}): Promise<void> {
  if (input.product !== 'nessie') return;
  const collection = deps.collection ?? await resolveCreditCollectionContext(input, { prisma });
  const stripe: Pick<Stripe, 'paymentMethods'> | null | undefined = collection.stripe;
  if (!collection.stripeCollectionEnabled || !stripe) {
    throw new AppError('FORBIDDEN', 402, 'NESSIE_BILLING_SETUP_REQUIRED');
  }
  // Subscription and credit Checkout have separate customers, but the same bound organisation and account.
  const customers = await prisma.billingStripeCustomer.findMany({ where: {
    accountId: collection.account.id, orgId: input.organisationId, teamId: null,
    stripeCustomerId: { not: null },
  }, select: { stripeCustomerId: true }, take: 11 });
  if (customers.length > 10) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_CREDIT_CUSTOMER_SCOPE_CONFLICT');
  for (const customer of customers) {
    if (!customer.stripeCustomerId) continue;
    const methods = await stripe.paymentMethods.list({ customer: customer.stripeCustomerId, type: 'card', limit: 1 });
    const method = methods.data[0];
    if (!method) continue;
    if (method.livemode !== collection.account.livemode || method.type !== 'card' || !method.card ||
      stripeExternalId(method.customer) !== customer.stripeCustomerId) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_METHOD_BINDING_UNPROVEN');
    }
    // Expiry follows the seat-renewal recovery policy. Already prepaid usage still needs its own hold.
    return;
  }
  throw new AppError('FORBIDDEN', 402, 'NESSIE_BILLING_SETUP_REQUIRED');
}
