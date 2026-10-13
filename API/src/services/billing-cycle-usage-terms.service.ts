import type { BillingTariff, PrismaClient } from '@prisma/client';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';

/** Public seats are newly accepted monthly terms, not a rewrite of older usage. */
export async function cycleUsageTariff(prisma: PrismaClient, input: {
  subscriptionId: string | null; serviceId: string; orgId: string; teamId: string; billingMonth: string; seatTariff: BillingTariff;
}) {
  if (!input.subscriptionId) return input.seatTariff;
  const subscription = await prisma.billingStripeSubscription.findUnique({ where: { id: input.subscriptionId },
    select: { checkout: { select: { seatOfferId: true } } } });
  if (!subscription?.checkout.seatOfferId) return input.seatTariff;
  return (await resolveBillingTariffForMonth(prisma, { serviceId: input.serviceId, organisationId: input.orgId,
    teamId: input.teamId, billingMonth: input.billingMonth })).tariff;
}
