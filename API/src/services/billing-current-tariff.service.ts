import type { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';

type Reader = Parameters<typeof resolveBillingTariffForMonth>[0] & Pick<Prisma.TransactionClient,
  'billingTariff' | 'billingOrganisationRegion'>;

/** Current purchase/admission terms only. Historical statements keep their monthly term history. */
export async function resolveCurrentBillingTariff(reader: Reader,
  scope: Parameters<typeof resolveBillingTariffForMonth>[1], product: string) {
  const effective = await resolveBillingTariffForMonth(reader, scope);
  if (product !== 'nessie' || effective.source !== 'SERVICE_DEFAULT') return effective;
  const selected = await reader.billingTariff.findFirst({
    where: { serviceId: scope.serviceId, isDefault: true },
  });
  if (!selected || selected.mode !== 'STANDARD' || selected.usagePaymentMode !== 'PREPAID' ||
    selected.collectionMode !== 'STRIPE' || !selected.anniversarySeats || selected.monthlyChargeBasis !== 'PER_SEAT' || selected.monthlyAmountMinor <= 0n) {
    throw new AppError('FORBIDDEN', 402, 'NESSIE_PREPAID_SETUP_REQUIRED');
  }
  const region = await reader.billingOrganisationRegion.findUnique({ where: { orgId: scope.organisationId } });
  if (!region || selected.currency === region.currency) return { ...effective, tariff: selected };
  const regional = await reader.billingTariff.findFirst({ where: {
    serviceId: scope.serviceId, key: 'standard-' + region.currency.toLowerCase(), currency: region.currency,
    mode: 'STANDARD', collectionMode: 'STRIPE', usagePaymentMode: 'PREPAID', usageCurrency: 'USD',
    monthlyChargeBasis: 'PER_SEAT', monthlyAmountMinor: { gt: 0n }, anniversarySeats: true,
  }, orderBy: { version: 'desc' } });
  if (!regional) throw new AppError('BAD_REQUEST', 409, 'NESSIE_REGIONAL_SEAT_TERMS_INVALID');
  return { ...effective, tariff: regional };
}
