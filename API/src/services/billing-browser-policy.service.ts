import { Prisma, type BillingBrowserPolicy, type PrismaClient } from '@prisma/client';
import type { BillingBrowserTariffV1 } from '@unlikeotherai/billing-statement-protocol';
import { AppError } from '../utils/errors.js';

/** Round provider time once, then use the common cumulative money rater. */
export function browserProviderCost(
  policy: Pick<BillingBrowserPolicy, 'providerUsdPerHour' | 'minimumSeconds' | 'roundingSeconds'>,
  milliseconds: number,
): Prisma.Decimal {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new AppError('BAD_REQUEST', 400);
  const seconds = Math.max(
    policy.minimumSeconds,
    Math.ceil(milliseconds / (policy.roundingSeconds * 1000)) * policy.roundingSeconds,
  );
  return policy.providerUsdPerHour.mul(seconds).div(3600).toDecimalPlaces(18, Prisma.Decimal.ROUND_UP);
}
export async function activeBrowserPolicy(
  tx: Prisma.TransactionClient | PrismaClient,
  serviceId: string,
  projectId: string,
  until = new Date(),
): Promise<BillingBrowserPolicy> {
  const policy = await tx.billingBrowserPolicy.findFirst({
    where: {
      serviceId,
      projectId,
      retiredAt: null,
      validUntil: { gt: until },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!policy) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_BROWSER_TARIFF_UNAVAILABLE');
  return policy;
}
export function publicBrowserTariff(row: BillingBrowserPolicy): BillingBrowserTariffV1 {
  return {
    policy_id: row.id,
    project_id: row.projectId,
    currency: 'USD',
    provider_price_per_hour: row.providerUsdPerHour.toFixed(),
    customer_price_per_minute: row.providerUsdPerHour.mul('1.1').div(60).toFixed(18),
    markup_bps: 1000,
    minimum_seconds: 60,
    rounding_seconds: row.roundingSeconds,
    valid_until: row.validUntil.toISOString(),
  };
}
