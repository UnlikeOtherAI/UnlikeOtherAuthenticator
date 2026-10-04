import { BillingTariffSource, Prisma, type BillingTariff } from '@prisma/client';

import { AppError } from '../utils/errors.js';

type Reader = Pick<Prisma.TransactionClient,
  'billingService' | 'billingTariffTermEvent' | 'billingOrganisationContractVersion'>;

export type EffectiveTariff = {
  tariff: BillingTariff;
  source: BillingTariffSource;
  assignmentId: string | null;
};

export function utcBillingMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function nextUtcBillingMonth(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    .toISOString().slice(0, 7);
}

export async function lockTariffHistoryService(
  tx: Prisma.TransactionClient,
  serviceId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "billing_services" WHERE "id" = ${serviceId} FOR UPDATE
  `);
  if (rows.length !== 1) throw new AppError('NOT_FOUND', 404, 'BILLING_SERVICE_NOT_FOUND');
}

export async function appendTariffTermEvent(
  tx: Prisma.TransactionClient,
  params: {
    serviceId: string;
    source: BillingTariffSource;
    scopeKey: string;
    effectiveFromMonth: string;
    tariffId: string | null;
    assignmentId?: string | null;
    actorEmail?: string | null;
    reason: string;
  },
): Promise<void> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.effectiveFromMonth)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  }
  await tx.billingTariffTermEvent.create({
    data: {
      ...params,
      assignmentId: params.assignmentId ?? null,
      actorEmail: params.actorEmail ?? null,
    },
  });
}

export async function resolveBillingTariffForMonth(
  reader: Reader,
  params: {
    serviceId: string;
    organisationId: string;
    teamId: string;
    billingMonth: string;
  },
): Promise<EffectiveTariff> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.billingMonth)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  }
  const service = await reader.billingService.findUnique({
    where: { id: params.serviceId },
    select: { tariffHistoryFromMonth: true },
  });
  if (!service) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_SERVICE_NOT_FOUND');
  }
  const contractVersions = await reader.billingOrganisationContractVersion.findMany({
    where: {
      effectiveFromMonth: { lte: params.billingMonth },
      contract: { orgId: params.organisationId, status: { in: ['ACTIVE', 'TERMINATED'] } },
      serviceTerms: { some: {} },
    },
    include: {
      serviceTerms: {
        where: { serviceId: params.serviceId },
        include: { tariff: true },
      },
    },
    orderBy: [{ effectiveFromMonth: 'desc' }, { version: 'desc' }],
  });
  const latestByContract = new Map<string, typeof contractVersions[number]>();
  for (const item of contractVersions) {
    if (!latestByContract.has(item.contractId)) latestByContract.set(item.contractId, item);
  }
  const claims = [...latestByContract.values()].filter((item) => item.serviceTerms.length > 0);
  if (claims.length > 1) {
    throw new AppError('INTERNAL', 409, 'BILLING_CONTRACT_TERMS_CONFLICT');
  }
  const contract = claims[0]?.serviceTerms[0];
  if (params.billingMonth < service.tariffHistoryFromMonth && !contract) {
    throw new AppError('INTERNAL', 409, 'BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED');
  }
  const choices = [
    { source: BillingTariffSource.TEAM, scopeKey: `${params.organisationId}:${params.teamId}` },
    { source: BillingTariffSource.ORGANISATION, scopeKey: params.organisationId },
    { source: BillingTariffSource.SERVICE_DEFAULT, scopeKey: params.serviceId },
  ];
  for (const choice of choices) {
    if (choice.source === BillingTariffSource.ORGANISATION && contract) {
      return { tariff: contract.tariff, source: BillingTariffSource.ORGANISATION,
        assignmentId: contract.tariffAssignmentId };
    }
    if (params.billingMonth < service.tariffHistoryFromMonth) continue;
    const event = await reader.billingTariffTermEvent.findFirst({
      where: {
        serviceId: params.serviceId,
        source: choice.source,
        scopeKey: choice.scopeKey,
        effectiveFromMonth: { lte: params.billingMonth },
      },
      orderBy: [{ effectiveFromMonth: 'desc' }, { sequence: 'desc' }],
      include: { tariff: true },
    });
    if (!event) continue;
    if (event.tariffId === null) continue;
    if (!event.tariff || event.tariff.serviceId !== params.serviceId) {
      throw new AppError('INTERNAL', 500, 'BILLING_TARIFF_HISTORY_CORRUPT');
    }
    return { tariff: event.tariff, source: choice.source, assignmentId: event.assignmentId };
  }
  throw new AppError('INTERNAL', 500, 'BILLING_DEFAULT_TARIFF_MISSING');
}
