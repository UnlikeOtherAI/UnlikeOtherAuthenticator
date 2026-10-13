import type { Prisma, PrismaClient } from '@prisma/client';
import { productPolicyAt } from './billing-product-entitlement.service.js';
import { AppError } from '../utils/errors.js';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';

export async function privateCompanyPolicy(db: Prisma.TransactionClient | PrismaClient,
  serviceId: string, orgId: string, now: Date) {
  const enrollment = await db.billingProductEnrollment.findUnique({ where: { serviceId_orgId: { serviceId, orgId } } });
  if (!enrollment?.active) return null;
  const policy = await productPolicyAt(db as Prisma.TransactionClient, enrollment.id, now);
  if (!policy?.privateAtCost || !policy.privateTermEventId) return null;
  const current = await db.billingTariffTermEvent.findFirst({ where: { serviceId,
    source: 'ORGANISATION', scopeKey: orgId, effectiveFromMonth: { lte: now.toISOString().slice(0, 7) } },
    orderBy: [{ effectiveFromMonth: 'desc' }, { sequence: 'desc' }] });
  if (current?.id !== policy.privateTermEventId) return null;
  const effective = await resolveBillingTariffForMonth(db, { serviceId, organisationId: orgId,
    teamId: null, billingMonth: now.toISOString().slice(0, 7), at: now });
  // A negotiated contract takes precedence over the generic organisation event.
  // Its later accepted terms cannot inherit the older private waiver.
  return effective.source === 'ORGANISATION' && effective.tariff.id === current.tariffId ? policy : null;
}

export async function assertPrivateTeamTariffChange(db: Prisma.TransactionClient,
  input: { serviceId: string; orgId: string; tariffId: string }) {
  const nextMonth = new Date(); nextMonth.setUTCDate(1); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  if (!await privateCompanyPolicy(db, input.serviceId, input.orgId, nextMonth)) return;
  const tariff = await db.billingTariff.findUniqueOrThrow({ where: { id: input.tariffId } });
  if (tariff.mode !== 'AT_COST' || tariff.monthlyAmountMinor !== 0n || tariff.collectionMode === 'NONE') {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_TEAM_OVERRIDE_CONFLICT');
  }
}
