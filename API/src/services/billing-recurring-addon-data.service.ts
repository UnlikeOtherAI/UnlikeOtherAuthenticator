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
  const currentCustomer={accountId:params.accountId,orgId:params.organisationId,scope:'ORGANISATION' as const,teamId:null};
  const [offers, subscriptions, checkouts,retainedSubscriptions] = await Promise.all([
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
        customer:currentCustomer,
        offer: { resourceKind: null },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.billingRecurringAddonCheckout.findMany({
      where: {
        accountId: params.accountId,
        serviceId: params.serviceId,
        orgId: params.organisationId,
        customer:currentCustomer,
        offer: { resourceKind: null },
        status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.billingRecurringAddonSubscription.findMany({where:{orgId:params.organisationId,serviceId:params.serviceId,
      offer:{resourceKind:null},status:{notIn:['canceled','incomplete_expired']},
      NOT:{accountId:params.accountId,customer:currentCustomer}},select:{offerKey:true}}),
  ]);
  return { offers, subscriptions, checkouts,retainedSubscriptions };
}

