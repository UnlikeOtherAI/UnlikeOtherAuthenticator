import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext,
  type StripeRuntime, type StripeAccountContext } from './billing-stripe-client.service.js';

/** Bounded sequential account work. One unavailable binding cannot starve another mode. */
export async function runStoredStripeAccountCycles<T>(prisma: PrismaClient,
  run: (runtime: StripeRuntime, account: StripeAccountContext) => Promise<T>,
): Promise<Array<{ accountId: string; result: T } | { accountId: string; error: string }>> {
  if (!getEnv().STRIPE_BILLING_ENABLED) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const accounts = await prisma.billingStripeAccount.findMany({ orderBy: { id: 'asc' } });
  const results: Array<{ accountId: string; result: T } | { accountId: string; error: string }> = [];
  for (const captured of accounts) {
    try {
      const runtime = requireStripeBillingEnabled(captured);
      const verified = await resolveStripeAccountContext(runtime.client, runtime.livemode, prisma);
      if (verified.id !== captured.id) throw new AppError('INTERNAL', 503, 'BILLING_STRIPE_ACCOUNT_MISMATCH');
      results.push({ accountId: captured.id, result: await run(runtime, verified) });
    } catch (error) {
      results.push({ accountId: captured.id,
        error: error instanceof AppError ? error.message : 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE' });
    }
  }
  return results;
}
