import { type BillingTariff, type Prisma, type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { NESSIE_COMMERCIAL_PRICES } from './billing-storage-catalog.service.js';

export function compatibleStandardSeatTariff(tariff: BillingTariff): boolean {
  const prices = NESSIE_COMMERCIAL_PRICES[tariff.currency as keyof typeof NESSIE_COMMERCIAL_PRICES];
  return Boolean(prices && tariff.monthlyAmountMinor === prices.seat && tariff.mode === 'STANDARD' &&
    tariff.collectionMode === 'STRIPE' && tariff.monthlyChargeBasis === 'PER_SEAT' && tariff.seatPolicy === 'AUTOMATIC' &&
    tariff.seatChargeTiming === 'PRORATED' && tariff.usagePaymentMode === 'PREPAID' &&
    tariff.usageCurrency === 'USD' && tariff.markupBps === 3000);
}

export async function requirePublishedSeatOffer(tx: Prisma.TransactionClient, serviceId: string, orgId: string, offerId: string) {
  const region = await tx.billingOrganisationRegion.findUnique({ where: { orgId } });
  const offer = await tx.billingSeatOffer.findFirst({ where: { id: offerId, serviceId, withdrawnAt: null }, include: { tariff: true } });
  if (!offer || !compatibleStandardSeatTariff(offer.tariff) || offer.tariff.currency !== region?.currency) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SEAT_OFFER_UNAVAILABLE');
  }
  const [seat, contract] = await Promise.all([
    tx.billingSeatSubscription.findFirst({ where: { serviceId, orgId, teamId: null, endedAt: null,
      OR: [{ commercialEndsAt: null }, { commercialEndsAt: { gt: new Date() } }] } }),
    tx.billingOrganisationContract.findFirst({ where: { orgId, status: 'ACTIVE',
      versions: { some: { serviceTerms: { some: { serviceId } } } } } }),
  ]);
  if (seat || contract) throw new AppError('BAD_REQUEST', 409, 'BILLING_SEAT_AGREEMENT_EXISTS');
  return offer;
}

export async function publishSeatOffer(input: { serviceId: string; tariffId: string; actor: LifecycleActor },
  deps?: { prisma?: PrismaClient }) {
  return (deps?.prisma ?? getAdminPrisma()).$transaction(async (tx) => {
    const email = await requireLifecycleActor(tx as PrismaClient, input.actor);
    const tariff = await tx.billingTariff.findFirst({ where: { id: input.tariffId, serviceId: input.serviceId,
      service: { identifier: 'nessie', active: true } } });
    if (!tariff || !compatibleStandardSeatTariff(tariff)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_STANDARD_SEAT_TERMS_INCOMPATIBLE');
    }
    const row = await tx.billingSeatOffer.upsert({ where: { tariffId: tariff.id }, create: {
      serviceId: input.serviceId, tariffId: tariff.id, publishedByEmail: email,
    }, update: {} });
    if (row.withdrawnAt) throw new AppError('BAD_REQUEST', 409, 'BILLING_SEAT_OFFER_WITHDRAWN');
    await tx.adminAuditLog.create({ data: { actorEmail: email, action: 'billing.company_seat_offer_published',
      metadata: { service_id: input.serviceId, tariff_id: tariff.id, offer_id: row.id } } });
    return { id: row.id };
  });
}

export async function withdrawSeatOffer(input: { serviceId: string; offerId: string; actor: LifecycleActor },
  deps?: { prisma?: PrismaClient }) {
  return (deps?.prisma ?? getAdminPrisma()).$transaction(async (tx) => {
    const email = await requireLifecycleActor(tx as PrismaClient, input.actor);
    await tx.billingSeatOffer.updateMany({ where: { id: input.offerId, serviceId: input.serviceId, withdrawnAt: null },
      data: { withdrawnAt: new Date() } });
    await tx.adminAuditLog.create({ data: { actorEmail: email, action: 'billing.company_seat_offer_withdrawn',
      metadata: { service_id: input.serviceId, offer_id: input.offerId } } });
  });
}
