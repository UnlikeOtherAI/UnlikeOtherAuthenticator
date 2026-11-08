import { type BillingStripeSubscription, type Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

import { billingAccessFingerprint, type DirectBillingServiceAccess } from './billing-service-access.service.js';

type StatePrisma = Pick<
  PrismaClient | Prisma.TransactionClient,
  'billingServiceAccess' | 'billingStripeSubscription'
>;

export type CancellationSubscription = BillingStripeSubscription & {
  service: { id: string; identifier: string; name: string };
  account: { id: string; stripeAccountId: string; livemode: boolean };
};

export type BillingCancellationState = {
  accesses: DirectBillingServiceAccess[];
  subscriptions: CancellationSubscription[];
  entitlementFingerprint: string;
  subscriptionFingerprint: string;
};

function subscriptionFingerprint(subscriptions: CancellationSubscription[]): string {
  const canonical = subscriptions
    .map((subscription) => ({
      id: subscription.id,
      accountId: subscription.accountId,
      serviceId: subscription.serviceId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      scope: subscription.scope,
      scopeKey: subscription.scopeKey,
      tariffId: subscription.tariffId,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function loadBillingCancellationState(
  params: { organisationId: string; teamId: string|null },
  deps: { prisma: StatePrisma },
): Promise<BillingCancellationState> {
  const subscriptions=await deps.prisma.billingStripeSubscription.findMany({where:{
    orgId:params.organisationId,status:{notIn:['canceled','incomplete_expired']}},
    include:{service:{select:{id:true,identifier:true,name:true}},
      account:{select:{id:true,stripeAccountId:true,livemode:true}}},orderBy:[{serviceId:'asc'},{createdAt:'desc'}]});
  const confirmedAccess=await deps.prisma.billingServiceAccess.findMany({where:{
    orgId:params.organisationId,active:true,revokedAt:null},select:{serviceId:true,userId:true}});
  const accesses=[...new Map(subscriptions.map(s=>[s.serviceId,{serviceId:s.serviceId,
    product:s.service.identifier,name:s.service.name,userIds:[...new Set(confirmedAccess
      .filter(a=>a.serviceId===s.serviceId).map(a=>a.userId))].sort()}])).values()];
  return {
    accesses,
    subscriptions,
    entitlementFingerprint: billingAccessFingerprint(accesses),
    subscriptionFingerprint: subscriptionFingerprint(subscriptions),
  };
}
