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
  /** When the region was chosen; its rate is captured then, or at the first valuation after. */
  setAt?: Date;
};
/** The rate the next credits used are valued at, and where it comes from. */
export type CreditNextRate = {
  currency: CreditPurchaseCurrency;
  usdPerUnit: string;
  source: 'usd' | 'purchase' | 'region';
  asOf: Date;
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
  const amountMinor = BigInt(amount.mul(100).toFixed(0));
  // A value that rounds to zero from below is zero, never "-0.00".
  return { currency, amount: amountMinor === 0n ? '0.00' : amount.toFixed(2), amountMinor };
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

/**
 * The rate the next credits used will be valued at: the oldest lot left after
 * holds when it was bought in the target currency, otherwise the target's own
 * rate (credits bought in USD, and debt). Like the lots, it never moves with
 * exchange rates; null when the target's rate is needed but not captured.
 */
export function creditNextRate(params: { lots: Array<CreditLotTerms & { openedAt: Date }>;
  reservedMicrocredits: bigint; target: CreditValueTarget; now: Date }): CreditNextRate | null {
  const { currency } = params.target;
  if (currency === 'USD') return { currency, usdPerUnit: '1', source: 'usd', asOf: params.now };
  let held = params.reservedMicrocredits;
  for (const lot of [...params.lots].sort((a, b) => a.sequence - b.sequence)) {
    const taken = held < lot.remainingMicrocredits ? held : lot.remainingMicrocredits;
    held -= taken;
    if (lot.remainingMicrocredits === taken) continue;
    if (lot.currency !== currency) break;
    return { currency, usdPerUnit: new Prisma.Decimal(lot.usdPerUnit).toFixed(), source: 'purchase',
      asOf: lot.openedAt };
  }
  return params.target.usdPerUnit === null ? null
    : { currency, usdPerUnit: params.target.usdPerUnit, source: 'region', asOf: params.target.setAt ?? params.now };
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
  const setAt = region.setAt;
  if (region.usdPerUnit) return { currency, usdPerUnit: region.usdPerUnit.toFixed(), setAt };
  if (!deps.stripe) return { currency, usdPerUnit: null, setAt };
  try {
    const rate = await readCreditPurchaseRate(currency, { stripe: deps.stripe, prisma: deps.db, now: deps.now });
    await deps.db.billingOrganisationRegion.updateMany({ where: { orgId: organisationId, usdPerUnit: null },
      data: { usdPerUnit: rate.baseRate } });
    const stored = await deps.db.billingOrganisationRegion.findUnique({ where: { orgId: organisationId } });
    return { currency, usdPerUnit: stored?.usdPerUnit?.toFixed() ?? rate.baseRate, setAt };
  } catch {
    return { currency, usdPerUnit: null, setAt };
  }
}

async function loadCreditLotState(params: { creditAccountId: string; organisationId: string },
  deps: { db: ValueDb; stripe: CreditPurchaseRateClient | null; now?: () => Date }) {
  const [lots, debt, reserved, target] = await Promise.all([
    deps.db.billingCreditLot.findMany({ where: { creditAccountId: params.creditAccountId,
      remainingMicrocredits: { gt: 0 } },
    select: { currency: true, usdPerUnit: true, remainingMicrocredits: true, sequence: true, openedAt: true } }),
    deps.db.billingCreditLotMovement.aggregate({ where: { creditAccountId: params.creditAccountId, lotId: null },
      _sum: { deltaMicrocredits: true } }),
    billingReservedMicrocredits(deps.db, params.creditAccountId),
    creditValueTarget(params.organisationId, deps),
  ]);
  return { lots, debtMicrocredits: -(debt._sum.deltaMicrocredits ?? 0n), reservedMicrocredits: reserved, target };
}

/** The account's available credits valued in its organisation's region currency, or null when they cannot be. */
export async function readCreditBalanceValue(params: { creditAccountId: string; organisationId: string },
  deps: { db?: ValueDb; stripe: CreditPurchaseRateClient | null; now?: () => Date }): Promise<CreditBalanceValue | null> {
  return creditBalanceValue(await loadCreditLotState(params, { ...deps, db: deps.db ?? getAdminPrisma() }));
}

export type CreditDisplayValues = {
  currency: CreditPurchaseCurrency;
  balance: CreditBalanceValue | null;
  nextRate: CreditNextRate | null;
  /** Each entry's value from its own lot movements; absent for an entry with none (history before lots). */
  entries: Map<string, CreditBalanceValue | null>;
};

/**
 * What a credits view shows in the region currency: the available balance, the
 * rate the next credits used are valued at, and each listed entry's value as a
 * magnitude. A grant is worth the lot it opened; any other entry is the sum of
 * what it drew from (or gave back to) each lot.
 */
export async function readCreditDisplayValues(params: { creditAccountId: string; organisationId: string;
  entryIds: string[] }, deps: { db?: ValueDb; stripe: CreditPurchaseRateClient | null; now?: () => Date }):
  Promise<CreditDisplayValues> {
  const db = deps.db ?? getAdminPrisma();
  const now = deps.now?.() ?? new Date();
  const listed = params.entryIds.length > 0;
  const [state, movements, opened] = await Promise.all([
    loadCreditLotState(params, { ...deps, db }),
    listed ? db.billingCreditLotMovement.findMany({
      where: { creditAccountId: params.creditAccountId, entryId: { in: params.entryIds } },
      select: { entryId: true, deltaMicrocredits: true, lot: { select: { currency: true, usdPerUnit: true } } },
    }) : [],
    listed ? db.billingCreditLot.findMany({
      where: { creditAccountId: params.creditAccountId, sourceEntryId: { in: params.entryIds } },
      select: { sourceEntryId: true, currency: true, usdPerUnit: true, paidAmountMinor: true,
        grantedMicrocredits: true },
    }) : [],
  ]);
  const byEntry = new Map<string, typeof movements>();
  for (const movement of movements) {
    if (!movement.entryId) continue;
    byEntry.set(movement.entryId, [...(byEntry.get(movement.entryId) ?? []), movement]);
  }
  const entries = new Map<string, CreditBalanceValue | null>();
  for (const [entryId, rows] of byEntry) {
    const value = creditMovementValue(rows, state.target);
    entries.set(entryId, value && value.amountMinor < 0n
      ? { ...value, amount: value.amount.slice(1), amountMinor: -value.amountMinor } : value);
  }
  // A grant is worth its lot: what was paid when it was bought in the region currency, otherwise its credits.
  for (const lot of opened) {
    if (!lot.sourceEntryId) continue;
    entries.set(lot.sourceEntryId, lot.currency === state.target.currency && lot.paidAmountMinor > 0n
      ? { currency: state.target.currency, amount: new Prisma.Decimal(lot.paidAmountMinor.toString()).div(100)
        .toFixed(2), amountMinor: lot.paidAmountMinor }
      : creditMovementValue([{ deltaMicrocredits: -lot.grantedMicrocredits, lot }], state.target));
  }
  return { currency: state.target.currency, balance: creditBalanceValue(state), entries,
    nextRate: creditNextRate({ ...state, now }) };
}
