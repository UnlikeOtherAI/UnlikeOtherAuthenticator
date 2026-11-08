import type { PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { AppError } from '../utils/errors.js';
import { freezeDisplayedBillingActions } from './billing-action-context.service.js';
import { resolveBillingDisplayBinding } from './billing-team-mode.service.js';
import { billingModeRefreshCopy } from './billing-mode-copy.catalog.js';
import type { billingStatementActions } from './billing-statement-action.service.js';
import type { getStripeSubscriptionSummary, BillingSubscriptionRequest } from './billing-stripe-subscription.service.js';

export async function bindStatementActions<T extends ReturnType<typeof billingStatementActions>>(actions: T,
  summary: Awaited<ReturnType<typeof getStripeSubscriptionSummary>>,
  subject: BillingSubscriptionRequest, appKeyId: string, negotiated: boolean,
  locale: BillingCustomerLocale | undefined, now: Date, prisma: PrismaClient) {
  const binding = await resolveBillingDisplayBinding(subject, appKeyId, summary.subscription?.id ?? null, prisma);
  if (!summary.subscription && summary.stripe_collection_enabled && binding.account.livemode !== (summary.stripe_mode === 'live')) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTEXT_STALE');
  }
  return freezeDisplayedBillingActions(actions, binding, negotiated, billingModeRefreshCopy(locale), now);
}
