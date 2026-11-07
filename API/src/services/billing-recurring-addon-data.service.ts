import { BillingRecurringAddonSubscriptionScope, type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';

export async function loadAddonData(
  params: {
    accountId: string;
    serviceId: string;
    organisationId: string;
    teamId: string;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [offers, subscriptions, checkouts] = await Promise.all([
    prisma.billingRecurringAddonOffer.findMany({
      where: { serviceId: params.serviceId, active: true, resourceKind: null },
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      include: {
        catalogs: { where: { accountId: params.accountId } },
        featurePolicies: { where: { active: true } },
      },
    }),
    prisma.billingRecurringAddonSubscription.findMany({
      where: {
        accountId: params.accountId,
        serviceId: params.serviceId,
        orgId: params.organisationId,
        offer: { resourceKind: null },
        OR: [
          {
            scope: BillingRecurringAddonSubscriptionScope.ORGANISATION,
            teamId: null,
            subscribingUserId: null,
          },
          {
            scope: BillingRecurringAddonSubscriptionScope.TEAM,
            teamId: params.teamId,
            subscribingUserId: null,
          },
          {
            scope: BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
            teamId: params.teamId,
            subscribingUserId: { not: null },
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.billingRecurringAddonCheckout.findMany({
      where: {
        accountId: params.accountId,
        serviceId: params.serviceId,
        orgId: params.organisationId,
        requestedTeamId: params.teamId,
        offer: { resourceKind: null },
        status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);
  return { offers, subscriptions, checkouts };
}

