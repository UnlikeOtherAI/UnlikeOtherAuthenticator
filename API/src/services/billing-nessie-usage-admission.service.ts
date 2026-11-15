import type { BillingTariff, Prisma } from '@prisma/client';
import { assertNessieSeatUsage } from './billing-nessie-seat-access.service.js';
import { type EffectiveTariff } from './billing-tariff-history.service.js';
import { resolveCurrentBillingTariff } from './billing-current-tariff.service.js';
import { AppError } from '../utils/errors.js';

type DefaultTerms = Pick<BillingTariff, 'mode' | 'usagePaymentMode' | 'collectionMode' |
  'monthlyChargeBasis' | 'monthlyAmountMinor' | 'seatPolicy' | 'seatChargeTiming'>;

function regularTerms(tariff: DefaultTerms): boolean {
  return tariff.mode === 'STANDARD' && tariff.usagePaymentMode === 'PREPAID' &&
    tariff.collectionMode === 'STRIPE' && tariff.monthlyChargeBasis === 'PER_SEAT' && tariff.monthlyAmountMinor > 0n &&
    tariff.seatPolicy === 'AUTOMATIC' && tariff.seatChargeTiming === 'PRORATED';
}

export function assertNessieDefaultTariff(product: string, tariff: DefaultTerms): void {
  if (product === 'nessie' && !regularTerms(tariff)) {
    throw new AppError('BAD_REQUEST', 400, 'NESSIE_REGULAR_DEFAULT_REQUIRED');
  }
}

/** A missing commercial setup must never turn a Nessie dispatch into uncollected PAYG. */
export function assertNessieUsageAdmission(product: string, effective: EffectiveTariff): void {
  if (product !== 'nessie') return;
  const { tariff, source } = effective;
  // A usage subsidy is an explicit organisation/team agreement, never a default.
  if (tariff.mode === 'FREE' && source !== 'SERVICE_DEFAULT') return;
  if (tariff.usagePaymentMode !== 'PREPAID' || tariff.mode === 'FREE') {
    throw new AppError('FORBIDDEN', 402, 'NESSIE_PREPAID_SETUP_REQUIRED');
  }
  if (source === 'SERVICE_DEFAULT' && !regularTerms(tariff)) {
    throw new AppError('FORBIDDEN', 402, 'NESSIE_PREPAID_SETUP_REQUIRED');
  }
}

/** Keep the tariff read and admission decision together in both reservation transactions. */
export async function resolveDispatchFundingTariff(
  reader: Prisma.TransactionClient,
  scope: Parameters<typeof resolveCurrentBillingTariff>[1] & { userId?: string }, product: string,
) {
  const effective = await resolveCurrentBillingTariff(reader, scope, product);
  assertNessieUsageAdmission(product, effective);
  await assertNessieSeatUsage(reader, { ...scope, product });
  return effective.tariff;
}
