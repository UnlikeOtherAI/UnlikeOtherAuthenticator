import {
  BillingProviderServiceLineKind,
  BillingTariffMode,
  BillingUsagePaymentMode,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';

// Connected provider-service rates (Docs/Requirements/billing-tariffs.md,
// "Connected provider-service rates"): inside one immutable prepaid tariff
// version, usage metered by one Ledger connector is rated with its own markup
// and shown under its own customer line. Everything else keeps the tariff's.

export type ProviderServiceLineKind = 'cloud_browser';

export type ProviderServiceRateInput = {
  providerServiceId: string;
  markupBps: number;
  lineKind: ProviderServiceLineKind;
};

export type ProviderServiceRate = ProviderServiceRateInput;

type Reader = PrismaClient | Prisma.TransactionClient;

const PROVIDER_SERVICE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MAX_MARKUP_BPS = 100_000;
const MAX_RATES = 20;

const toDatabaseKind: Record<ProviderServiceLineKind, BillingProviderServiceLineKind> = {
  cloud_browser: BillingProviderServiceLineKind.CLOUD_BROWSER,
};

export function providerServiceLineKindToPublic(kind: BillingProviderServiceLineKind): ProviderServiceLineKind {
  if (kind === BillingProviderServiceLineKind.CLOUD_BROWSER) return 'cloud_browser';
  throw new AppError('INTERNAL', 500, 'BILLING_PROVIDER_SERVICE_LINE_KIND_UNKNOWN');
}

/** Validates the rates of a new tariff version. Only prepaid standard/custom
 * versions may carry them: pay-as-you-go export, portfolio credit allocation
 * and manual contract invoices rate one markup per product. */
export function normalizeProviderServiceRates(
  rates: ProviderServiceRateInput[] | undefined,
  tariff: { mode: BillingTariffMode; usagePaymentMode: BillingUsagePaymentMode },
): { providerServiceId: string; markupBps: number; lineKind: BillingProviderServiceLineKind }[] {
  if (!rates || rates.length === 0) return [];
  if (tariff.usagePaymentMode !== BillingUsagePaymentMode.PREPAID ||
    (tariff.mode !== BillingTariffMode.STANDARD && tariff.mode !== BillingTariffMode.CUSTOM)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_PROVIDER_SERVICE_RATES_REQUIRE_PREPAID');
  }
  if (rates.length > MAX_RATES) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PROVIDER_SERVICE_RATES');
  }
  const seen = new Set<string>();
  return rates.map((rate) => {
    const providerServiceId = rate.providerServiceId.trim().toLowerCase();
    if (!PROVIDER_SERVICE_PATTERN.test(providerServiceId) || seen.has(providerServiceId) ||
      !Number.isInteger(rate.markupBps) || rate.markupBps < 0 || rate.markupBps > MAX_MARKUP_BPS ||
      !Object.hasOwn(toDatabaseKind, rate.lineKind)) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_PROVIDER_SERVICE_RATES');
    }
    seen.add(providerServiceId);
    return { providerServiceId, markupBps: rate.markupBps, lineKind: toDatabaseKind[rate.lineKind] };
  });
}

export async function loadProviderServiceRates(reader: Reader, tariffId: string): Promise<ProviderServiceRate[]> {
  const rows = await reader.billingTariffProviderServiceRate.findMany({
    where: { tariffId }, orderBy: { providerServiceId: 'asc' },
  });
  return rows.map((row) => ({ providerServiceId: row.providerServiceId, markupBps: row.markupBps,
    lineKind: providerServiceLineKindToPublic(row.lineKind) }));
}

/** The markup that rates one Ledger connector's usage under this tariff. */
export function effectiveMarkupBps(
  tariff: { markupBps: number },
  rates: readonly ProviderServiceRate[],
  providerServiceId: string | null,
): number {
  return rates.find((rate) => rate.providerServiceId === providerServiceId)?.markupBps ?? tariff.markupBps;
}

/** The customer line a connector's usage is shown under, or null for the product's metered usage. */
export function providerServiceLineKind(
  rates: readonly ProviderServiceRate[],
  providerServiceId: string | null,
): ProviderServiceLineKind | null {
  return rates.find((rate) => rate.providerServiceId === providerServiceId)?.lineKind ?? null;
}

/** Gross credits of a team's month per connected provider-service line kind,
 * from the immutable paid-usage liabilities whose frozen markup rated them. */
export async function readProviderServiceKindConsumption(
  reader: Reader,
  scope: { serviceId: string; organisationId: string; teamId: string; billingMonth: string },
  rates: readonly ProviderServiceRate[],
): Promise<Map<ProviderServiceLineKind, bigint>> {
  const consumption = new Map<ProviderServiceLineKind, bigint>();
  if (rates.length === 0) return consumption;
  const rows = await reader.billingPaidUsageLiability.findMany({
    where: { serviceId: scope.serviceId, orgId: scope.organisationId, teamId: scope.teamId,
      billingMonth: scope.billingMonth,
      providerServiceId: { in: rates.map((rate) => rate.providerServiceId) } },
    select: { providerServiceId: true, ratedMicrocredits: true },
  });
  for (const row of rows) {
    const kind = providerServiceLineKind(rates, row.providerServiceId);
    if (kind) consumption.set(kind, (consumption.get(kind) ?? 0n) + row.ratedMicrocredits);
  }
  return consumption;
}
