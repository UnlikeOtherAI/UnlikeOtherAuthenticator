import { createHash } from 'node:crypto';

import {
  BillingAssignmentScope, BillingCreditEntryDirection, BillingCreditEntryKind,
  BillingPrepaidReservationStatus, BillingUsagePaymentMode,
  type BillingTariff, type Prisma, type PrismaClient,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { addBillingDecimals } from './billing-money.service.js';
import { stripeMeterQuantityFromMajorAmount } from './billing-stripe-usage-validation.service.js';
import type { RawMeteringLine } from './billing-metering.types.js';

type Reader = PrismaClient | Prisma.TransactionClient;

export type CycleCreditEvidence = {
  team_id: string;
  source: 'settlement' | 'reservation';
  covered: boolean;
  consumed_microcredits: string | null;
  funded_debit_microcredits: string | null;
  source_ids: string[];
  fingerprint: string;
};

function hold(): never {
  throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_CREDIT_SOURCE_CONFLICT');
}

function evidence(teamId: string, source: CycleCreditEvidence['source'],
  consumed: bigint | null, fundedDebit: bigint | null,
  sourceIds: string[], facts: unknown): CycleCreditEvidence {
  return { team_id: teamId, source, covered: consumed !== null,
    consumed_microcredits: consumed?.toString() ?? null,
    funded_debit_microcredits: fundedDebit?.toString() ?? null,
    source_ids: sourceIds,
    fingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}

function correctPayer(account: { orgId: string; teamId: string | null;
  scope: BillingAssignmentScope }, orgId: string, teamId: string,
  payer: BillingAssignmentScope): boolean {
  return account.orgId === orgId && account.scope === payer &&
    account.teamId === (payer === BillingAssignmentScope.TEAM ? teamId : null);
}

/** Reads only actual UOA settlement or reservation debit authority. Missing
 * coverage stays pending; a complete zero-rated month is the one safe zero. */
export async function readCycleCreditEvidence(
  reader: Reader,
  params: { orgId: string; teamId: string; serviceId: string; billingMonth: string;
    payer: BillingAssignmentScope; tariff: BillingTariff; ratedAmount: string;
    rawLines: RawMeteringLine[] },
): Promise<CycleCreditEvidence> {
  if (params.tariff.currency !== 'USD') {
    return evidence(params.teamId, 'settlement', null, null, [], { reason: 'currency' });
  }
  const expectedRated = stripeMeterQuantityFromMajorAmount(params.ratedAmount, 'USD');
  if (params.tariff.usagePaymentMode !== BillingUsagePaymentMode.PREPAID) {
    const settlements = await reader.billingCreditUsageSettlement.findMany({ where: {
      serviceId: params.serviceId, teamId: params.teamId,
      billingMonth: params.billingMonth,
      creditAccount: { orgId: params.orgId },
    }, include: { creditAccount: { select: { orgId: true, teamId: true, scope: true } },
      adjustments: { orderBy: { sequence: 'desc' }, take: 1,
        select: { id: true, cumulativeRatedUsageAmountMicroMinor: true,
          cumulativeCreditsConsumedMicrocredits: true } } },
    });
    if (settlements.length > 1) hold();
    const row = settlements[0];
    if (!row) {
      return evidence(params.teamId, 'settlement', expectedRated === 0n ? 0n : null,
        expectedRated === 0n ? 0n : null, [],
        { rated: expectedRated.toString(), present: false });
    }
    if (!correctPayer(row.creditAccount, params.orgId, params.teamId, params.payer) ||
      row.tariffId !== params.tariff.id || row.currency !== 'USD' ||
      row.cumulativeCreditsConsumedMicrocredits < 0n ||
      row.cumulativeCreditsConsumedMicrocredits % 10n !== 0n) hold();
    const adjustment = row.adjustments[0];
    const covered = row.status === 'APPLIED' && adjustment &&
      adjustment.cumulativeRatedUsageAmountMicroMinor === expectedRated &&
      adjustment.cumulativeRatedUsageAmountMicroMinor ===
        row.cumulativeRatedUsageAmountMicroMinor &&
      adjustment.cumulativeCreditsConsumedMicrocredits ===
        row.cumulativeCreditsConsumedMicrocredits;
    return evidence(params.teamId, 'settlement',
      covered ? expectedRated * 10n : null,
      covered ? row.cumulativeCreditsConsumedMicrocredits : null,
      [row.id, ...(adjustment ? [adjustment.id] : [])],
      { rated: expectedRated.toString(), row_id: row.id, status: row.status,
        row_rated: row.cumulativeRatedUsageAmountMicroMinor.toString(),
        consumed: row.cumulativeCreditsConsumedMicrocredits.toString() });
  }

  const reservations = await reader.billingPrepaidReservation.findMany({ where: {
    orgId: params.orgId, teamId: params.teamId, serviceId: params.serviceId,
    billingMonth: params.billingMonth,
  }, include: { creditAccount: { select: { orgId: true, teamId: true, scope: true } },
    creditEntry: { select: { id: true, direction: true, kind: true,
      amountMicrocredits: true } } }, orderBy: { id: 'asc' } });
  const rawCost = params.rawLines.filter((line) => line.billingDisposition === 'paid')
    .reduce((total, line) => addBillingDecimals(total,
      line.selectedProviderCost ?? hold()), '0');
  let actualRawCost = '0';
  let consumed = 0n;
  let complete = true;
  for (const row of reservations) {
    if (!correctPayer(row.creditAccount, params.orgId, params.teamId, params.payer) ||
      row.tariffId !== params.tariff.id || row.currency !== 'USD') hold();
    if (row.status === BillingPrepaidReservationStatus.ACTIVE) complete = false;
    if (row.status !== BillingPrepaidReservationStatus.SETTLED) continue;
    if (!row.receiptId || row.rawCostActual === null || row.debitedMicrocredits === null ||
      row.debitedMicrocredits < 0n) hold();
    actualRawCost = addBillingDecimals(actualRawCost, row.rawCostActual.toFixed(18));
    consumed += row.debitedMicrocredits;
    if (row.debitedMicrocredits > 0n && (!row.creditEntry ||
      row.creditEntry.direction !== BillingCreditEntryDirection.DEBIT ||
      row.creditEntry.kind !== BillingCreditEntryKind.PREPAID_USAGE ||
      row.creditEntry.amountMicrocredits !== row.debitedMicrocredits)) hold();
    if (row.debitedMicrocredits === 0n && row.creditEntry) hold();
  }
  complete = complete && rawCost === actualRawCost &&
    (expectedRated === 0n || reservations.some((row) =>
      row.status === BillingPrepaidReservationStatus.SETTLED));
  return evidence(params.teamId, 'reservation', complete ? consumed : null,
    complete ? consumed : null,
    reservations.map((row) => row.id),
    { rated: expectedRated.toString(), raw_cost: rawCost,
      actual_raw_cost: actualRawCost, rows: reservations.map((row) => ({
        id: row.id, status: row.status, receipt_id: row.receiptId,
        debited: row.debitedMicrocredits?.toString() ?? null,
      })) });
}

export function decimalCredits(microcredits: bigint): string {
  const digits = microcredits.toString().padStart(7, '0');
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
