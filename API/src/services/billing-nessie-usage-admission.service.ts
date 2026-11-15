import { resolveBillingTariffForMonth, type EffectiveTariff } from './billing-tariff-history.service.js';
import { AppError } from '../utils/errors.js';

/** A missing commercial setup must never turn a Nessie dispatch into uncollected PAYG. */
export function assertNessieUsageAdmission(product: string, effective: EffectiveTariff): void {
  if (product !== 'nessie') return;
  const { tariff, source } = effective;
  // A usage subsidy is an explicit organisation/team agreement, never a default.
  if (tariff.mode === 'FREE' && source !== 'SERVICE_DEFAULT') return;
  if (tariff.usagePaymentMode !== 'PREPAID' || tariff.mode === 'FREE') {
    throw new AppError('FORBIDDEN', 402, 'NESSIE_PREPAID_SETUP_REQUIRED');
  }
  if (source === 'SERVICE_DEFAULT' && (tariff.mode !== 'STANDARD'
    || tariff.collectionMode !== 'STRIPE'
    || tariff.monthlyChargeBasis !== 'PER_SEAT'
    || tariff.monthlyAmountMinor <= 0n)) {
    throw new AppError('FORBIDDEN', 402, 'NESSIE_PREPAID_SETUP_REQUIRED');
  }
}

/** Keep the tariff read and admission decision together in both reservation transactions. */
export async function resolveDispatchFundingTariff(
  reader: Parameters<typeof resolveBillingTariffForMonth>[0],
  scope: Parameters<typeof resolveBillingTariffForMonth>[1], product: string,
) {
  const effective = await resolveBillingTariffForMonth(reader, scope);
  assertNessieUsageAdmission(product, effective);
  return effective.tariff;
}
