import { BillingTariffMode } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { NormalizedMeteringPortfolio } from './billing-metering.types.js';
import { addBillingDecimals, multiplyBillingDecimalByBps } from './billing-money.service.js';
import { stripeMeterQuantityFromMajorAmount } from './billing-stripe-usage-validation.service.js';

export type CreditRatingService = {
  id: string;
  identifier: string;
  name: string;
  tariff: {
    id: string;
    mode: BillingTariffMode;
    markupBps: number;
    currency: string;
  };
};

export type PreviousCreditAllocation = {
  serviceId: string;
  userId: string | null;
  consumedMicrocredits: bigint;
};

export type RatedCreditAllocation = {
  userId: string | null;
  ratedMicroMinor: bigint;
  consumedMicrocredits: bigint;
  remainingMicroMinor: bigint;
};

export type RatedCreditService = {
  service: CreditRatingService;
  ratedMicroMinor: bigint;
  consumedMicrocredits: bigint;
  remainingMicroMinor: bigint;
  allocations: RatedCreditAllocation[];
};

type Bucket = {
  service: CreditRatingService;
  userId: string | null;
  ratedMicroMinor: bigint;
  previousConsumedMicrocredits: bigint;
  targetConsumedCredits: bigint;
};

const MICROCREDITS_PER_CREDIT = 1_000_000n;
const MICRO_MINOR_PER_CREDIT = 100_000n;
const NULL_USER_KEY = '\uffff';

function bucketKey(serviceId: string, userId: string | null): string {
  return `${serviceId}\0${userId ?? NULL_USER_KEY}`;
}

function compareBuckets(left: Bucket, right: Bucket): number {
  const service = left.service.identifier.localeCompare(right.service.identifier);
  if (service !== 0) return service;
  if (left.userId === right.userId) return 0;
  if (left.userId === null) return 1;
  if (right.userId === null) return -1;
  return left.userId.localeCompare(right.userId);
}

function selectedCost(line: NormalizedMeteringPortfolio['lines'][number]): string | null {
  if (line.selectedProviderCost === null && line.currency === null) return null;
  if (line.selectedProviderCost === null || line.currency !== 'USD') {
    throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_COST_INVALID');
  }
  return line.selectedProviderCost;
}

function ratedMicroMinor(baseCost: string, service: CreditRatingService): bigint {
  if (service.tariff.currency !== 'USD') {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_TARIFF_CURRENCY_INVALID');
  }
  if (service.tariff.mode === BillingTariffMode.FREE) return 0n;
  const rated = multiplyBillingDecimalByBps(baseCost, 10_000 + service.tariff.markupBps);
  return stripeMeterQuantityFromMajorAmount(rated, 'USD');
}

function billableCreditCapacity(bucket: Bucket): bigint {
  return bucket.ratedMicroMinor / MICRO_MINOR_PER_CREDIT;
}

function allocateAdditionalCredits(buckets: Bucket[], requestedCredits: bigint): void {
  if (requestedCredits <= 0n) return;
  const candidates = buckets
    .map((bucket) => ({
      bucket,
      capacity: billableCreditCapacity(bucket) - bucket.targetConsumedCredits,
    }))
    .filter((candidate) => candidate.capacity > 0n);
  const totalCapacity = candidates.reduce((sum, candidate) => sum + candidate.capacity, 0n);
  if (requestedCredits > totalCapacity || totalCapacity === 0n) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_ALLOCATION_INVALID');
  }

  let allocated = 0n;
  const remainders = candidates.map((candidate) => {
    const numerator = candidate.capacity * requestedCredits;
    const credits = numerator / totalCapacity;
    candidate.bucket.targetConsumedCredits += credits;
    allocated += credits;
    return { ...candidate, remainder: numerator % totalCapacity };
  });
  remainders.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareBuckets(left.bucket, right.bucket);
  });
  let outstanding = requestedCredits - allocated;
  for (const candidate of remainders) {
    if (outstanding === 0n) break;
    if (candidate.bucket.targetConsumedCredits < billableCreditCapacity(candidate.bucket)) {
      candidate.bucket.targetConsumedCredits += 1n;
      outstanding -= 1n;
    }
  }
  if (outstanding !== 0n) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_ALLOCATION_INVALID');
  }
}

export function rateCreditPortfolio(params: {
  portfolio: NormalizedMeteringPortfolio;
  services: CreditRatingService[];
  previousAllocations: PreviousCreditAllocation[];
  balanceMicrocredits: bigint;
  validTeamUserIds: Set<string>;
}): RatedCreditService[] {
  const servicesByIdentifier = new Map(
    params.services.map((service) => [service.identifier, service]),
  );
  const servicesById = new Map(params.services.map((service) => [service.id, service]));
  const baseCosts = new Map<
    string,
    { service: CreditRatingService; userId: string | null; amount: string }
  >();

  for (const line of params.portfolio.lines) {
    const service = servicesByIdentifier.get(line.billingProduct);
    if (!service) throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_SERVICE_UNKNOWN');
    if (line.userId !== null && !params.validTeamUserIds.has(line.userId)) {
      throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_USER_INVALID');
    }
    const cost = selectedCost(line);
    if (cost === null) continue;
    const key = bucketKey(service.id, line.userId);
    const current = baseCosts.get(key);
    baseCosts.set(key, {
      service,
      userId: line.userId,
      amount: addBillingDecimals(current?.amount ?? '0', cost),
    });
  }

  const previous = new Map<string, PreviousCreditAllocation>();
  for (const allocation of params.previousAllocations) {
    if (allocation.consumedMicrocredits < 0n || allocation.consumedMicrocredits % 10n !== 0n) {
      throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_PREVIOUS_ALLOCATION_INVALID');
    }
    const service = servicesById.get(allocation.serviceId);
    if (!service) throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_SERVICE_MISSING');
    previous.set(bucketKey(service.id, allocation.userId), allocation);
  }

  const keys = new Set([...baseCosts.keys(), ...previous.keys()]);
  const buckets = [...keys].map((key) => {
    const cost = baseCosts.get(key);
    const old = previous.get(key);
    const service = cost?.service ?? servicesById.get(old?.serviceId ?? '');
    if (!service) throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_SERVICE_MISSING');
    const rated = cost ? ratedMicroMinor(cost.amount, service) : 0n;
    const previousConsumedMicrocredits = old?.consumedMicrocredits ?? 0n;
    const previousConsumedCredits = previousConsumedMicrocredits / MICROCREDITS_PER_CREDIT;
    const capacityCredits = rated / MICRO_MINOR_PER_CREDIT;
    return {
      service,
      userId: cost?.userId ?? old?.userId ?? null,
      ratedMicroMinor: rated,
      previousConsumedMicrocredits,
      targetConsumedCredits:
        previousConsumedCredits < capacityCredits ? previousConsumedCredits : capacityCredits,
    } satisfies Bucket;
  });
  buckets.sort(compareBuckets);

  const releasedMicrocredits = buckets.reduce(
    (sum, bucket) =>
      sum +
      (bucket.previousConsumedMicrocredits -
        bucket.targetConsumedCredits * MICROCREDITS_PER_CREDIT),
    0n,
  );
  const balanceAfterRelease = params.balanceMicrocredits + releasedMicrocredits;
  const availableCredits =
    balanceAfterRelease > 0n ? balanceAfterRelease / MICROCREDITS_PER_CREDIT : 0n;
  const remainingCapacity = buckets.reduce(
    (sum, bucket) => sum + billableCreditCapacity(bucket) - bucket.targetConsumedCredits,
    0n,
  );
  allocateAdditionalCredits(
    buckets,
    availableCredits < remainingCapacity ? availableCredits : remainingCapacity,
  );

  const byService = new Map<string, RatedCreditService>();
  for (const service of params.services) {
    byService.set(service.id, {
      service,
      ratedMicroMinor: 0n,
      consumedMicrocredits: 0n,
      remainingMicroMinor: 0n,
      allocations: [],
    });
  }
  for (const bucket of buckets) {
    const target = byService.get(bucket.service.id);
    if (!target) throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_SERVICE_MISSING');
    const consumedMicrocredits = bucket.targetConsumedCredits * MICROCREDITS_PER_CREDIT;
    const remainingMicroMinor =
      bucket.ratedMicroMinor - bucket.targetConsumedCredits * MICRO_MINOR_PER_CREDIT;
    target.ratedMicroMinor += bucket.ratedMicroMinor;
    target.consumedMicrocredits += consumedMicrocredits;
    target.remainingMicroMinor += remainingMicroMinor;
    target.allocations.push({
      userId: bucket.userId,
      ratedMicroMinor: bucket.ratedMicroMinor,
      consumedMicrocredits,
      remainingMicroMinor,
    });
  }
  return [...byService.values()].sort((left, right) =>
    left.service.identifier.localeCompare(right.service.identifier),
  );
}
