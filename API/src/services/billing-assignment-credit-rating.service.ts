import type { Prisma } from '@prisma/client';
import type { NormalizedMeteringPortfolio } from './billing-metering.types.js';
import { addBillingDecimals, subtractBillingDecimals } from './billing-money.service.js';
import { AppError } from '../utils/errors.js';
import { stripeMeterQuantityFromMajorAmount } from './billing-stripe-usage-validation.service.js';
import { assignmentCutoffs } from './billing-tariff-history.service.js';

/** Match the month's Ledger costs per user to the dispatch liabilities before
 * allocating credits. Prepaid dispatches already consumed their wallet funds. */
export async function assignmentCreditRating(tx: Prisma.TransactionClient,
  service: { id: string; identifier: string }, portfolio: NormalizedMeteringPortfolio, existingSnapshotId?: string) {
  const { organizationId: organisationId, teamId, month: billingMonth } = portfolio.scope;
  const cutoffs = await assignmentCutoffs(tx, { serviceId: service.id, organisationId, teamId, billingMonth });
  const firstCutoff = cutoffs[0];
  if (!firstCutoff) return null;
  // A verified cursor can be replayed after later dispatches settle. Its
  // original allocations committed atomically with the portfolio snapshot.
  if (existingSnapshotId) {
    const adjustment = await tx.billingCreditUsageSettlementAdjustment.findFirst({
      where: { portfolioSnapshotId: existingSnapshotId, serviceId: service.id },
      select: { settlementId: true, sequence: true, settlement: { select: { tariffId: true } } },
    });
    const allocations = adjustment ? await tx.billingCreditUsageAllocation.groupBy({
      by: ['attributedUserId'],
      where: { settlementId: adjustment.settlementId, adjustment: { sequence: { lte: adjustment.sequence } } },
      _sum: { deltaRatedUsageAmountMicroMinor: true },
    }) : [];
    const amounts = new Map(allocations.map(row =>
      [row.attributedUserId, row._sum.deltaRatedUsageAmountMicroMinor ?? 0n]));
    return { amounts, paygTariffId: adjustment?.settlement.tariffId ?? null };
  }
  if (firstCutoff > new Date(portfolio.snapshot.capturedAt)) return null;
  const where = { serviceId: service.id, orgId: organisationId, teamId, billingMonth };
  const [payg, prepaid] = await Promise.all([
    tx.billingPaidUsageLiability.groupBy({
      by: ['userId', 'tariffId', 'currency'], where: { ...where, paymentMode: 'PAY_AS_YOU_GO' },
      _sum: { rawCostActual: true, ratedQuanta: true }, orderBy: { tariffId: 'asc' },
    }),
    // Settled reservations cover both current and pre-migration wallet debits.
    tx.billingPrepaidReservation.groupBy({
      by: ['userId', 'currency'], where: { ...where, status: 'SETTLED' },
      _sum: { rawCostActual: true },
    }),
  ]);
  const remaining = new Map<string | null, string>();
  for (const line of portfolio.lines) {
    if (line.billingProduct !== service.identifier || line.billingDisposition !== 'paid') continue;
    if (line.selectedProviderCost === null || line.currency !== 'USD') {
      throw new AppError('INTERNAL', 409, 'LEDGER_CREDIT_COST_INVALID');
    }
    remaining.set(line.userId, addBillingDecimals(remaining.get(line.userId) ?? '0', line.selectedProviderCost));
  }
  let paygTariffId: string | null = null;
  const quanta = new Map<string | null, bigint>();
  for (const row of [...prepaid, ...payg]) {
    if (row.currency !== 'USD' || !row._sum.rawCostActual) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_PAID_COST_MISSING');
    }
    remaining.set(row.userId, subtractBillingDecimals(remaining.get(row.userId) ?? '0', row._sum.rawCostActual.toFixed()));
  }
  for (const row of payg) {
    if (!row._sum.ratedQuanta) throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_PAID_COST_MISSING');
    paygTariffId = row.tariffId;
    quanta.set(row.userId, (quanta.get(row.userId) ?? 0n) + BigInt(row._sum.ratedQuanta.toFixed(0)));
  }
  if ([...remaining.values()].some(cost => cost !== '0')) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_METERING_RECEIPT_COST_MISMATCH');
  }
  const amounts = new Map<string | null, bigint>();
  for (const [userId, exact] of quanta) {
    const digits = exact.toString().padStart(23, '0');
    amounts.set(userId, stripeMeterQuantityFromMajorAmount(`${digits.slice(0, -22)}.${digits.slice(-22)}`, 'USD'));
  }
  return { amounts, paygTariffId };
}
