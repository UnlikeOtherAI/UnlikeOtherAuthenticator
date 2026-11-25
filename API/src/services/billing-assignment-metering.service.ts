import type { PrismaClient } from '@prisma/client';
import { addBillingDecimals } from './billing-money.service.js';
import { AppError } from '../utils/errors.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { billingModeToPublic } from './billing-tariff-serialization.service.js';
import { assignmentCutoffs, resolveBillingTariffForMonth } from './billing-tariff-history.service.js';
import { meteringIsComplete, type NormalizedMeteringUsage } from './billing-metering.types.js';

export async function meteringWithAssignmentTerms(prisma: PrismaClient, serviceId: string,
  usage: NormalizedMeteringUsage, fetchUsage = fetchLedgerMeteringUsage) {
  const { organizationId: organisationId, teamId, month: billingMonth } = usage.scope;
  if (!billingMonth) throw new AppError('INTERNAL', 502, 'BILLING_MONTH_INVALID');
  const scope = { serviceId, organisationId, teamId, billingMonth };
  const cutoffs = await assignmentCutoffs(prisma, scope);
  if (!cutoffs.length) return usage;
  // Ledger places provider receipts in half-open windows by dispatch start, including
  // delayed receipts. Keep service/caller/user attribution for each price interval.
  const boundaries = [...new Set([usage.scope.startsAt, ...cutoffs.map(d => d.toISOString()), usage.scope.endsAt])];
  const lines = [];
  for (const [i, start] of boundaries.entries()) {
    const end = boundaries[i + 1];
    if (!end) break;
    const [part, effective] = await Promise.all([
      fetchUsage({ ...scope, product: usage.product, groupBy: usage.groupBy, period: { startsAt: start, endsAt: end } }),
      resolveBillingTariffForMonth(prisma, { ...scope, asOf: new Date(start) }),
    ]);
    if (!meteringIsComplete(part.billingCompleteness)) {
      throw new AppError('INTERNAL', 409, 'LEDGER_METERING_UNRESOLVED_PAID_USAGE');
    }
    const terms = { mode: billingModeToPublic(effective.tariff.mode), markupBps: effective.tariff.markupBps };
    lines.push(...part.lines.map(line => ({ ...line, terms })));
  }
  // A late receipt can appear between snapshots. Retry rather than combining
  // a stale monthly observation with new interval totals or attribution.
  function costs(rows: NormalizedMeteringUsage['lines']) {
    const result = new Map<string, string>();
    for (const row of rows) {
      const key = JSON.stringify([row.serviceId, row.usageUnit, row.userId, row.callerProduct,
        row.originProduct, row.billingProduct, row.currency, row.billingDisposition]);
      result.set(key, addBillingDecimals(result.get(key) ?? '0', row.selectedProviderCost ?? '0'));
    }
    return result;
  }
  const monthly = costs(usage.lines);
  const parts = costs(lines);
  if (monthly.size !== parts.size || [...monthly].some(([key, value]) => parts.get(key) !== value)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_METERING_RECEIPT_COST_MISMATCH');
  }
  return { ...usage, lines };
}
