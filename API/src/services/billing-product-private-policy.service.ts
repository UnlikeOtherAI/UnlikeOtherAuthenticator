import type { Prisma, PrismaClient } from '@prisma/client';
import { productPolicyAt } from './billing-product-entitlement.service.js';
import { AppError } from '../utils/errors.js';

export async function privateCompanyPolicy(db: Prisma.TransactionClient | PrismaClient,
  serviceId: string, orgId: string, now: Date) {
  const enrollment = await db.billingProductEnrollment.findUnique({ where: { serviceId_orgId: { serviceId, orgId } } });
  if (!enrollment?.active) return null;
  const policy = await productPolicyAt(db as Prisma.TransactionClient, enrollment.id, now);
  if (!policy?.privateAtCost || !policy.privateTermEventId) return null;
  const current = await db.billingTariffTermEvent.findFirst({ where: { serviceId,
    source: 'ORGANISATION', scopeKey: orgId, effectiveFromMonth: { lte: now.toISOString().slice(0, 7) } },
    orderBy: [{ effectiveFromMonth: 'desc' }, { sequence: 'desc' }] });
  return current?.id === policy.privateTermEventId ? policy : null;
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
