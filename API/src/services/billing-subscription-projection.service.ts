import type { BillingStatementV1,BillingCustomerLocale } from '../contracts/billing-statement-v1.js';
import { billingAddonCopy,billingAddonSubscriptionStatus } from './billing-addon-copy.catalog.js';
import type { getStripeSubscriptionSummary } from './billing-stripe-subscription.service.js';

export function billingSubscriptionProjection(summary:Awaited<ReturnType<typeof getStripeSubscriptionSummary>>,
  locale?:BillingCustomerLocale):BillingStatementV1['subscription'] {
  const subscription=summary.subscription;
  return subscription?{id:subscription.id,status:subscription.status,
    display_status:subscription.cancel_at_period_end?billingAddonCopy(locale).cancelsAtPeriodEnd:
      billingAddonSubscriptionStatus(subscription.status,locale),
    scope:subscription.scope==='team'?'team':'organisation',cancel_at_period_end:subscription.cancel_at_period_end,
    current_period_start:subscription.current_period_start,current_period_end:subscription.current_period_end}:null;
}
