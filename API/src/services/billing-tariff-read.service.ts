import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { tariffRetireBlockers } from './billing-tariff-retirement.service.js';

type EventReader = Pick<Prisma.TransactionClient, 'billingTariffTermEvent'>;

/** The month each assignment's newest term event (highest sequence) takes effect. Two queries. */
export async function assignmentEffectiveFromMonths(
  reader: EventReader,
  assignmentIds: readonly string[],
): Promise<Map<string, string>> {
  if (assignmentIds.length === 0) return new Map();
  const newest = await reader.billingTariffTermEvent.groupBy({
    by: ['assignmentId'],
    where: { assignmentId: { in: [...assignmentIds] } },
    _max: { sequence: true },
  });
  const sequences = newest.flatMap((row) => row._max.sequence === null ? [] : [row._max.sequence]);
  if (sequences.length === 0) return new Map();
  const events = await reader.billingTariffTermEvent.findMany({
    where: { sequence: { in: sequences } },
    select: { assignmentId: true, effectiveFromMonth: true },
  });
  return new Map(events.flatMap((event) =>
    event.assignmentId ? [[event.assignmentId, event.effectiveFromMonth] as const] : []));
}

export async function listBillingServices(deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const services = await prisma.billingService.findMany({
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
  // Every assignment's tariff is one of its service's tariffs, so one blocker pass covers both.
  const [blockers, effectiveFrom] = await Promise.all([
    tariffRetireBlockers(prisma, services.flatMap((service) => service.tariffs)),
    assignmentEffectiveFromMonths(prisma,
      services.flatMap((service) => service.assignments.map((assignment) => assignment.id))),
  ]);
  const describe = <T extends { id: string }>(tariff: T) =>
    ({ ...tariff, retireBlockedBy: blockers.get(tariff.id) ?? [] });
  return services.map((service) => ({
    ...service,
    tariffs: service.tariffs.map(describe),
    assignments: service.assignments.map((assignment) => ({
      ...assignment,
      tariff: describe(assignment.tariff),
      effectiveFromMonth: effectiveFrom.get(assignment.id) ?? null,
    })),
  }));
}
