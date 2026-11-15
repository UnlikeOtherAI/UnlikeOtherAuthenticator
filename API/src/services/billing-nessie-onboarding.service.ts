import type { Prisma } from '@prisma/client';

import { assertContractAssignmentWriteAllowed } from './billing-contract-guard.service.js';
import { assertTariffAssignmentChangeAllowed } from './billing-stripe-tariff-guard.service.js';
import { appendTariffTermEvent, lockTariffHistoryService, utcBillingMonth } from './billing-tariff-history.service.js';

type NewTariff = {
  collectionMode: string; monthlyChargeBasis: string; monthlyAmountMinor: bigint;
  seatPolicy: string | null; seatChargeTiming: string | null; usagePaymentMode: string; mode: string;
};

/** Freeze the collection model on new tariff versions, including operator-priced assignments. */
export function usesAnniversarySeats(product: string, tariff: NewTariff): boolean {
  return product === 'nessie' && tariff.collectionMode === 'STRIPE' && tariff.monthlyChargeBasis === 'PER_SEAT' &&
    tariff.monthlyAmountMinor > 0n && tariff.seatPolicy === 'AUTOMATIC' && tariff.seatChargeTiming === 'PRORATED' &&
    (tariff.usagePaymentMode === 'PREPAID' || tariff.mode === 'FREE');
}

export async function assignNewNessieOrganisation(tx: Prisma.TransactionClient, input: {
  serviceId: string; orgId: string; userId: string; issuer: string; currency: string; now: Date;
}) {
  await lockTariffHistoryService(tx, input.serviceId);
  const org = await tx.organisation.findUniqueOrThrow({ where: { id: input.orgId }, select: { domain: true, createdAt: true } });
  if (input.issuer !== 'https://' + org.domain) return;
  const key = 'standard-' + input.currency.toLowerCase();
  const where = { serviceId: input.serviceId, key, currency: input.currency, anniversarySeats: true, mode: 'STANDARD' as const };
  const published = await tx.billingTariff.findFirst({ where: { ...where, createdAt: { lte: org.createdAt } }, select: { id: true } });
  if (!published) return;
  const tariff = await tx.billingTariff.findFirstOrThrow({ where, orderBy: { version: 'desc' } });
  // An explicit team, organisation or contract arrangement takes precedence over initial defaults.
  const [assignment, contract] = await Promise.all([
    tx.billingTariffAssignment.findFirst({ where: { serviceId: input.serviceId, orgId: input.orgId }, select: { id: true } }),
    tx.billingContractServiceTerm.findFirst({ where: { serviceId: input.serviceId,
      contractVersion: { contract: { orgId: input.orgId } } }, select: { id: true } }),
  ]);
  if (assignment || contract) return;
  await assertContractAssignmentWriteAllowed(tx, { serviceId: input.serviceId, organisationId: input.orgId, teamId: null });
  await assertTariffAssignmentChangeAllowed(tx, { serviceId: input.serviceId, orgId: input.orgId,
    teamId: null, targetTariffId: tariff.id, currentAssignmentId: null });
  const created = await tx.billingTariffAssignment.create({ data: {
    serviceId: input.serviceId, orgId: input.orgId, scope: 'ORGANISATION', scopeKey: input.orgId,
    tariffId: tariff.id, createdByUserId: input.userId,
  } });
  await appendTariffTermEvent(tx, { serviceId: input.serviceId, source: 'ORGANISATION', scopeKey: input.orgId,
    effectiveFromMonth: utcBillingMonth(input.now), tariffId: tariff.id, assignmentId: created.id, reason: 'new-organisation-region' });
}
