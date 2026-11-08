import { type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';

export async function loadAddonData(
  params: {
    accountId: string;
    serviceId: string;
    organisationId: string;
    teamId: string|null;
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
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.billingRecurringAddonCheckout.findMany({
      where: {
        accountId: params.accountId,
        serviceId: params.serviceId,
        orgId: params.organisationId,
        offer: { resourceKind: null },
        status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);
  return { offers, subscriptions, checkouts };
}

