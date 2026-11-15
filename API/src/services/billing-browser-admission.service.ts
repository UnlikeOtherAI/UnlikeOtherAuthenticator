import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { assertNessieCardOnFile } from './billing-nessie-card-admission.service.js';
import { requireTeamStripeBilling } from './billing-team-mode.service.js';
import { resolveStripeAccountContext } from './billing-stripe-client.service.js';

/** A prepaid balance never substitutes for the organisation's billing setup. */
export async function browserPaidAccount(
  scope: { product: string; organisationId: string; teamId: string },
  prisma: PrismaClient,
  stripe?: Pick<Stripe, 'accounts' | 'paymentMethods'>,
) {
  const configured = await requireTeamStripeBilling(scope, prisma);
  if (!configured.livemode) throw new AppError('FORBIDDEN', 403, 'BILLING_BROWSER_LIVE_CREDITS_REQUIRED');
  const client = stripe ?? configured.client;
  const account = await resolveStripeAccountContext(client, configured.livemode, prisma);
  await assertNessieCardOnFile(scope, prisma, {
    collection: { account, stripeCollectionEnabled: true, stripe: client },
  });
  return account;
}
