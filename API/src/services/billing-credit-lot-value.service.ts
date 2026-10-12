import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { readCreditPurchaseRate, type CreditPurchaseRateClient } from './billing-credit-purchase-rate.service.js';
import type { CreditPurchaseCurrency } from './billing-stripe-catalog-provisioning-spec.js';

const MICROCREDITS_PER_USD = new Prisma.Decimal(1_000_000_000);

export type CreditLotTerms = {
  currency: string;
  usdPerUnit: Prisma.Decimal | string;
  remainingMicrocredits: bigint;
  sequence: number;
};
export type CreditValueTarget = {
  currency: CreditPurchaseCurrency;
  /** USD per unit of `currency`: 1 for USD, the region's captured rate otherwise; null when not captured. */
  usdPerUnit: string | null;
};
export type CreditBalanceValue = {
  currency: CreditPurchaseCurrency;
  /** Exact value, rounded down to the currency's minor unit. */
  amount: string;
  amountMinor: bigint;
};

/**
 * What `microcredits` drawn from a lot are worth in `target`. A lot in the
 * target currency keeps the rate it was bought at, so its value never moves with
 * exchange rates; credits bought in another currency (USD before a region was
 * chosen) are valued through USD at the target's captured rate.
 */
function lotValue(lot: Pick<CreditLotTerms, 'currency' | 'usdPerUnit'>, microcredits: bigint,
  target: CreditValueTarget): Prisma.Decimal | null {
  const usd = new Prisma.Decimal(microcredits.toString()).div(MICROCREDITS_PER_USD);
  if (lot.currency === target.currency) return usd.div(lot.usdPerUnit);
  if (target.currency === 'USD') return usd;
  return target.usdPerUnit === null ? null : usd.div(target.usdPerUnit);
}

function rounded(currency: CreditPurchaseCurrency, value: Prisma.Decimal): CreditBalanceValue {
  const amount = value.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  return { currency, amount: amount.toFixed(2), amountMinor: BigInt(amount.mul(100).toFixed(0)) };
}

/**
 * The available balance valued in `target`: holds are taken from the oldest
 * lots first (where their settlement will draw), debt is valued at the
 * target's rate, and nothing is valued at a rate the lots were not bought at.
 */
export function creditBalanceValue(params: { lots: CreditLotTerms[]; debtMicrocredits: bigint;
  reservedMicrocredits: bigint; target: CreditValueTarget }): CreditBalanceValue | null {
  let held = params.reservedMicrocredits;
  let total = new Prisma.Decimal(0);
  for (const lot of [...params.lots].sort((a, b) => a.sequence - b.sequence)) {
    const taken = held < lot.remainingMicrocredits ? held : lot.remainingMicrocredits;
    held -= taken;
    const value = lotValue(lot, lot.remainingMicrocredits - taken, params.target);
    if (value === null) return null;
    total = total.add(value);
  }
  // Holds beyond the lots, and debt, are owed in credits valued at the target's rate.
  const owed = params.debtMicrocredits + held;
  if (owed > 0n) {
    const value = lotValue({ currency: 'USD', usdPerUnit: '1' }, owed, params.target);
    if (value === null) return null;
    total = total.sub(value);
  }
  return rounded(params.target.currency, total);
}

/** The value of one entry's draws or restorations, from its own movements. */
export function creditMovementValue(movements: Array<{ deltaMicrocredits: bigint;
  lot: Pick<CreditLotTerms, 'currency' | 'usdPerUnit'> | null }>, target: CreditValueTarget): CreditBalanceValue | null {
  let total = new Prisma.Decimal(0);
  for (const movement of movements) {
    const magnitude = movement.deltaMicrocredits < 0n ? -movement.deltaMicrocredits : movement.deltaMicrocredits;
    const value = lotValue(movement.lot ?? { currency: 'USD', usdPerUnit: '1' }, magnitude, target);
    if (value === null) return null;
    total = movement.deltaMicrocredits < 0n ? total.add(value) : total.sub(value);
  }
  return rounded(target.currency, total);
}

type ValueDb = Pick<PrismaClient, 'billingCreditLot' | 'billingCreditLotMovement' | 'billingOrganisationRegion'
  | 'billingPrepaidReservation' | 'billingSmsReservation' | 'billingSmsStandingHold' | 'billingSmsFxSnapshot'>;

/**
 * The region an organisation's credits are valued in and its captured rate.
 * A region chosen before a rate could be read captures it here, once.
 */
export async function creditValueTarget(organisationId: string, deps: { db: ValueDb;
  stripe: CreditPurchaseRateClient | null; now?: () => Date }): Promise<CreditValueTarget> {
  const region = await deps.db.billingOrganisationRegion.findUnique({ where: { orgId: organisationId } });
  if (!region || region.currency === 'USD') return { currency: 'USD', usdPerUnit: '1' };
  const currency = region.currency as CreditPurchaseCurrency;
  if (region.usdPerUnit) return { currency, usdPerUnit: region.usdPerUnit.toFixed() };
  if (!deps.stripe) return { currency, usdPerUnit: null };
  try {
    const rate = await readCreditPurchaseRate(currency, { stripe: deps.stripe, prisma: deps.db, now: deps.now });
    await deps.db.billingOrganisationRegion.updateMany({ where: { orgId: organisationId, usdPerUnit: null },
      data: { usdPerUnit: rate.baseRate } });
    const stored = await deps.db.billingOrganisationRegion.findUnique({ where: { orgId: organisationId } });
    return { currency, usdPerUnit: stored?.usdPerUnit?.toFixed() ?? rate.baseRate };
  } catch {
    return { currency, usdPerUnit: null };
  }
}

/** The account's available credits valued in its organisation's region currency, or null when they cannot be. */
export async function readCreditBalanceValue(params: { creditAccountId: string; organisationId: string },
  deps: { db?: ValueDb; stripe: CreditPurchaseRateClient | null; now?: () => Date }): Promise<CreditBalanceValue | null> {
  const db = deps.db ?? getAdminPrisma();
  const [lots, debt, reserved, target] = await Promise.all([
    db.billingCreditLot.findMany({ where: { creditAccountId: params.creditAccountId, remainingMicrocredits: { gt: 0 } },
      select: { currency: true, usdPerUnit: true, remainingMicrocredits: true, sequence: true } }),
    db.billingCreditLotMovement.aggregate({ where: { creditAccountId: params.creditAccountId, lotId: null },
      _sum: { deltaMicrocredits: true } }),
    billingReservedMicrocredits(db, params.creditAccountId),
    creditValueTarget(params.organisationId, { db, stripe: deps.stripe, now: deps.now }),
  ]);
  return creditBalanceValue({ lots, debtMicrocredits: -(debt._sum.deltaMicrocredits ?? 0n), reservedMicrocredits: reserved,
    target });
}
