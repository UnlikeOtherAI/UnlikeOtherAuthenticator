import { createHash } from 'node:crypto';

import type { BillingTariff } from '@prisma/client';

import type { BillingCycleUsageLine } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { sumBillingDecimals } from './billing-money.service.js';
import {
  meteringIsComplete, type NormalizedMeteringUsage, type RawMeteringLine,
} from './billing-metering.types.js';
import { exactMoney } from './billing-money.service.js';
import { rateProviderCost } from './billing-rating.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

export function projectCycleUsage(
  usage: NormalizedMeteringUsage,
  expected: { serviceIdentifier: string; organisationId: string; teamId: string;
    billingMonth: string; startsAt: Date; endsAt: Date; currency: string },
  tariff: BillingTariff,
): { lines: BillingCycleUsageLine[]; evidence: { team_id: string; snapshot_id: string;
  cursor: string; sha256: string; captured_at: string; line_count: number;
  content_sha256: string; raw_lines: RawMeteringLine[] } } {
  if (usage.product !== expected.serviceIdentifier || usage.groupBy !== 'user' ||
    usage.scope.organizationId !== expected.organisationId ||
    usage.scope.teamId !== expected.teamId || usage.scope.userId !== null ||
    usage.scope.month !== expected.billingMonth ||
    usage.scope.startsAt !== expected.startsAt.toISOString() ||
    usage.scope.endsAt !== expected.endsAt.toISOString() || !usage.snapshot.immutable) {
    hold('BILLING_CYCLE_LEDGER_SCOPE_MISMATCH');
  }
  if (!meteringIsComplete(usage.billingCompleteness)) {
    hold('BILLING_CYCLE_LEDGER_COVERAGE_UNRESOLVED');
  }
  // A new signed assertion can produce a new immutable observation cursor for
  // identical receipts. Financial replay identity is the rated source facts,
  // not the assertion, capture time or delivery snapshot hash.
  const contentSha256 = createHash('sha256').update(JSON.stringify({
    calls: usage.calls, lines: usage.lines.map((line) => JSON.stringify(line)).sort(),
    billingCompleteness: usage.billingCompleteness,
  })).digest('hex');
  const ratedCharges = usage.lines.flatMap((line) => {
    if (line.billingProduct !== expected.serviceIdentifier) {
      hold('BILLING_CYCLE_LEDGER_PRODUCT_MISMATCH');
    }
    if (line.billingDisposition === 'paid') {
      if (line.selectedProviderCost === null || line.currency === null) {
        hold('BILLING_CYCLE_PAID_COST_MISSING');
      }
      if (line.currency !== expected.currency) hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
      const rated = rateProviderCost(line.selectedProviderCost, line.currency, {
        mode: tariff.mode.toLowerCase() as 'standard' | 'free' | 'at_cost' | 'custom',
        markupBps: tariff.markupBps,
      });
      return [rated.total];
    } else if (line.selectedProviderCost !== null || line.currency !== null) {
      hold('BILLING_CYCLE_NONBILLABLE_COST_CONFLICT');
    }
    return [];
  });
  const lines: BillingCycleUsageLine[] = usage.lines.length === 0 ? [] : [{
    id: `usage:${createHash('sha256').update(`${expected.serviceIdentifier}\0${expected.teamId}\0${expected.billingMonth}`).digest('hex')}`,
    label: 'Metered usage',
    customer_charge: exactMoney(sumBillingDecimals(ratedCharges), expected.currency),
    credits_consumed: null,
  }];
  return { lines, evidence: { team_id: expected.teamId,
    snapshot_id: usage.snapshot.id, cursor: usage.snapshot.cursor,
    sha256: usage.snapshot.sha256, captured_at: usage.snapshot.capturedAt,
    line_count: usage.lines.length, content_sha256: contentSha256,
    raw_lines: usage.lines } };
}

export type CycleUsageEvidence = ReturnType<typeof projectCycleUsage>['evidence'];

/** Organisation finance sees a combined service view, never source team/user IDs. */
export function aggregateOrganisationCycleUsage(
  sourceLines: BillingCycleUsageLine[],
): BillingCycleUsageLine[] {
  if (sourceLines.length === 0) return [];
  const currency = sourceLines.find((line) => line.customer_charge)?.customer_charge?.currency;
  if (sourceLines.some((line) => line.customer_charge &&
    line.customer_charge.currency !== currency)) hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
  const amount = sumBillingDecimals(sourceLines.flatMap((line) =>
    line.customer_charge ? [line.customer_charge.amount] : []));
  return [{ id: 'usage:organisation', label: 'Metered usage',
    customer_charge: currency ? exactMoney(amount, currency) : null,
    credits_consumed: null }];
}

/** Assertion/cursor changes do not change the underlying financial receipts. */
export function cycleUsageContentFingerprint(rows: CycleUsageEvidence[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map((row) => ({
    team_id: row.team_id, content_sha256: row.content_sha256,
  })).sort((a, b) => a.team_id.localeCompare(b.team_id)))).digest('hex');
}
