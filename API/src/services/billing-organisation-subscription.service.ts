import { billingSubscriptionProjection } from './billing-subscription-projection.service.js';
import type { PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale, BillingOrganisationSubscriptionV1 }
  from '../contracts/billing-statement-v1.js';
import { billingStatementCopy } from './billing-statement-copy.catalog.js';

import { getStripeSubscriptionSummary } from './billing-stripe-subscription.service.js';
import { billingStatementActions } from './billing-statement-action.service.js';
import { subscriptionPortalCopy } from './billing-subscription-portal-copy.service.js';
import { bindStatementActions } from './billing-statement-mode.service.js';
import { exactMoney, minorAmountToMajor } from './billing-money.service.js';
import type { OrganisationBillingContext } from './billing-organisation-authority.service.js';

export async function readOrganisationSubscription(context: OrganisationBillingContext,
  prisma: PrismaClient, locale: BillingCustomerLocale | undefined, now: Date): Promise<BillingOrganisationSubscriptionV1> {
  const summary = await getStripeSubscriptionSummary(context,{prisma});
  const displayed=billingStatementActions(summary,context.request,context.credential,locale);
  if(summary.subscription){
    const portal=await subscriptionPortalCopy({subscriptionId:summary.subscription.id,organisationId:context.request.organisationId,
      serviceId:context.credential.service.id,...(locale?{locale}:{})},prisma);
    displayed.actions=displayed.actions.map(action=>action.id==='portal'?{...action,...portal}:action);
  }
  const actions = await bindStatementActions(displayed,
    summary,context.request,context.credential.id,true,locale,now,prisma);
  const monthly = summary.tariff.monthly_subscription;
  return {
    plan: { display_name: billingStatementCopy(locale).monthlySubscription,
      collection_mode: summary.tariff.collection_mode, usage_payment_mode: summary.tariff.usage_payment_mode,
      monthly_subscription: { ...monthly,
        ...exactMoney(minorAmountToMajor(monthly.amount_minor,monthly.currency),monthly.currency,locale) },
      assignment: summary.assignment },
    collection: { payment_collection_enabled: summary.tariff.payment_collection_enabled,
      stripe_collection_enabled: summary.stripe_collection_enabled, stripe_mode: summary.stripe_mode },
    subscription:billingSubscriptionProjection(summary,locale),
    ...actions,
  };
}
