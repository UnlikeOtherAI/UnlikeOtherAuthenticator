import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';

export async function listBillingServices(deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.billingService.findMany({
    orderBy: { identifier: 'asc' },
    include: {
      tariffs: { orderBy: [{ key: 'asc' }, { version: 'desc' }] },
      assignments: {
        orderBy: [{ scope: 'asc' }, { scopeKey: 'asc' }],
        include: {
          tariff: true,
          org: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
        },
      },
      appKeys: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          purpose: true,
          name: true,
          keyPrefix: true,
          actorIssuer: true,
          actorAudience: true,
          actorKeyId: true,
          checkoutReturnOrigins: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdByEmail: true,
          createdAt: true,
        },
      },
      adjustments: {
        orderBy: [{ active: 'desc' }, { startsAt: 'desc' }],
        include: {
          org: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
        },
      },
      stripeCatalogs: {
        orderBy: { currency: 'asc' },
        include: {
          account: {
            select: { stripeAccountId: true, livemode: true },
          },
          tariffPrices: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
      stripeSubscriptions: {
        orderBy: { createdAt: 'desc' },
        include: {
          account: {
            select: { stripeAccountId: true, livemode: true },
          },
          org: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
        },
      },
    },
  });
}
