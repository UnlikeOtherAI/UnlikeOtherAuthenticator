import {
  BillingAssignmentScope, BillingMonthlyChargeBasis, BillingSeatPolicy,
  type Prisma,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';
import {
  normalizeTariffInput, type PublicMonthlyChargeBasis,
  type PublicSeatChargeTiming, type PublicSeatPolicy, type PublicUsagePaymentMode,
} from './billing-tariff-input.service.js';
import { observedBillingTime } from './billing-seat-observed-time.service.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;

export type ContractServiceActivation = {
  serviceId: string;
  monthlyAmountMinor: string;
  monthlyChargeBasis?: PublicMonthlyChargeBasis;
  seatPolicy?: PublicSeatPolicy;
  seatChargeTiming?: PublicSeatChargeTiming;
  usagePaymentMode?: PublicUsagePaymentMode;
  fixedSeatQuantity?: number | null;
};

export type NormalizedContractService = ContractServiceActivation & { amount: bigint };

export function normalizeContractServices(services: ContractServiceActivation[]): NormalizedContractService[] {
  const seen = new Set<string>();
  if (services.length < 1 || services.length > 100) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_SERVICES_INVALID');
  }
  return services.map((service) => {
    let amount: bigint;
    try {
      amount = BigInt(service.monthlyAmountMinor);
    } catch {
      throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_SERVICES_INVALID');
    }
    if (!service.serviceId || seen.has(service.serviceId) ||
      !/^(0|[1-9]\d*)$/.test(service.monthlyAmountMinor) || amount > MAX_INT64) {
      throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_SERVICES_INVALID');
    }
    seen.add(service.serviceId);
    return { ...service, amount };
  });
}

export function contractSeatTerms(
  requested: NormalizedContractService,
  version: { usageMarkupBps: number; currency: string },
  identity: { key: string; name: string },
) {
  const tariff = normalizeTariffInput({
    ...identity, mode: 'custom', collectionMode: 'manual',
    markupBps: version.usageMarkupBps, currency: version.currency,
    monthlyAmountMinor: requested.monthlyAmountMinor,
    monthlyChargeBasis: requested.monthlyChargeBasis,
    seatPolicy: requested.seatPolicy,
    seatChargeTiming: requested.seatChargeTiming,
    usagePaymentMode: requested.usagePaymentMode,
  });
  const fixed = tariff.monthlyChargeBasis === BillingMonthlyChargeBasis.PER_SEAT &&
    tariff.seatPolicy === BillingSeatPolicy.FIXED;
  const fixedSeatQuantity = requested.fixedSeatQuantity ?? null;
  if ((fixed && (!Number.isSafeInteger(fixedSeatQuantity) || fixedSeatQuantity === null ||
    fixedSeatQuantity < 1 || fixedSeatQuantity > 1_000_000)) ||
    (!fixed && fixedSeatQuantity !== null)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_FIXED_SEAT_QUANTITY_INVALID');
  }
  return { tariff, fixedSeatQuantity };
}

export async function createManualSeatAgreement(
  tx: Prisma.TransactionClient,
  params: {
    serviceId: string;
    tariffId: string;
    termId: string;
    orgId: string;
    monthlyChargeBasis: BillingMonthlyChargeBasis;
    seatPolicy: BillingSeatPolicy | null;
    seatChargeTiming: 'FULL_MONTH' | 'PRORATED' | null;
    amount: bigint;
    currency: string;
    fixedSeatQuantity: number | null;
    commercialEffectiveAt: Date;
  },
): Promise<void> {
  if (params.monthlyChargeBasis !== BillingMonthlyChargeBasis.PER_SEAT) return;
  if (!params.seatPolicy || !params.seatChargeTiming) {
    throw new AppError('INTERNAL', 500, 'BILLING_CONTRACT_SEAT_TERMS_INVALID');
  }
  const activatedAt = await observedBillingTime(tx);
  if (params.commercialEffectiveAt < activatedAt) {
    throw new AppError('BAD_REQUEST', 409,
      'BILLING_CONTRACT_RETROACTIVE_TERMS_RECONCILIATION_REQUIRED');
  }
  const agreement = await tx.billingSeatSubscription.create({ data: {
    contractServiceTermId: params.termId, serviceId: params.serviceId,
    tariffId: params.tariffId, orgId: params.orgId, teamId: null,
    scope: BillingAssignmentScope.ORGANISATION,
    seatPolicy: params.seatPolicy, seatChargeTiming: params.seatChargeTiming,
    unitAmountMinor: params.amount, currency: params.currency,
    activatedAt, baselineCapturedAt: activatedAt,
    commercialEffectiveAt: params.commercialEffectiveAt,
  } });
  if (params.seatPolicy === BillingSeatPolicy.FIXED) {
    if (!params.fixedSeatQuantity) {
      throw new AppError('INTERNAL', 500, 'BILLING_CONTRACT_SEAT_TERMS_INVALID');
    }
    await tx.billingFixedSeatCapacityRevision.create({ data: {
      seatSubscriptionId: agreement.id,
      quantity: params.fixedSeatQuantity,
      effectiveAt: activatedAt,
    } });
  }
}
