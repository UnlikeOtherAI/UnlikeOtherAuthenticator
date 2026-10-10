import { createHash } from 'node:crypto';

import { BillingUsagePaymentMode, type BillingTariff } from '@prisma/client';

import type { BillingCycleUsageLine } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { compareBillingCycleUtf8 } from './billing-cycle-binary-order.service.js';
import { sumBillingDecimals } from './billing-money.service.js';
import {
  meteringIsComplete, type NormalizedMeteringUsage, type RawMeteringLine,
} from './billing-metering.types.js';
import { exactMoney } from './billing-money.service.js';
import { rateProviderCost } from './billing-rating.service.js';
import { decimalCredits } from './billing-cycle-credit-evidence.service.js';
import {
  effectiveMarkupBps, providerServiceLineKind,
  type ProviderServiceLineKind, type ProviderServiceRate,
} from './billing-provider-service-rate.service.js';

const LINE_KINDS: readonly ProviderServiceLineKind[] = ['cloud_browser'];

/** The connected provider-service line kind encoded in a cycle usage line id. */
export function cycleUsageLineKind(line: { id: string }): ProviderServiceLineKind | null {
  const segments = line.id.split(':');
  return LINE_KINDS.find((kind) => segments.includes(kind)) ?? null;
}

const kindLabel = (kind: ProviderServiceLineKind | null, prepaid: boolean) =>
  kind === 'cloud_browser' ? 'Cloud browser' : prepaid ? 'Prepaid usage' : 'Metered usage';

/** Splits a team's credit consumption across its usage lines: each connected
 * provider-service line gets its own receipts' credits, the product line the rest. */
export function withCycleLineCredits(lines: BillingCycleUsageLine[], consumed: bigint | null,
  byKind: ReadonlyMap<ProviderServiceLineKind, bigint>): BillingCycleUsageLine[] {
  if (consumed === null) return lines.map((line) => ({ ...line, credits_consumed: null }));
  let kindTotal = 0n;
  for (const line of lines) {
    const kind = cycleUsageLineKind(line);
    if (kind) kindTotal += byKind.get(kind) ?? 0n;
  }
  const rest = consumed - kindTotal;
  if (rest < 0n || (rest !== 0n && lines.every((line) => cycleUsageLineKind(line) !== null))) {
    hold('BILLING_CYCLE_CREDIT_SOURCE_CONFLICT');
  }
  return lines.map((line) => {
    const kind = cycleUsageLineKind(line);
    return { ...line, credits_consumed: decimalCredits(kind ? byKind.get(kind) ?? 0n : rest) };
  });
}

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

export function projectCycleUsage(
  usage: NormalizedMeteringUsage,
  expected: { serviceIdentifier: string; organisationId: string; teamId: string;
    billingMonth: string; startsAt: Date; endsAt: Date; currency: string },
  tariff: BillingTariff,
  providerServiceRates: readonly ProviderServiceRate[] = [],
): { lines: BillingCycleUsageLine[]; ratedAmount: string; evidence: { team_id: string; snapshot_id: string;
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
  const prepaid = tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID;
  if (providerServiceRates.length > 0 && !prepaid) hold('BILLING_CYCLE_PROVIDER_RATES_REQUIRE_PREPAID');
  // A new signed assertion can produce a new immutable observation cursor for
  // identical receipts. Financial replay identity is the rated source facts,
  // not the assertion, capture time or delivery snapshot hash.
  const contentSha256 = createHash('sha256').update(JSON.stringify({
    calls: usage.calls, lines: usage.lines.map((line) => JSON.stringify(line)).sort(compareBillingCycleUtf8),
    billingCompleteness: usage.billingCompleteness,
  })).digest('hex');
  const ratedLines = usage.lines.map((line) => {
    if (line.billingProduct !== expected.serviceIdentifier) {
      hold('BILLING_CYCLE_LEDGER_PRODUCT_MISMATCH');
    }
    const kind = providerServiceLineKind(providerServiceRates, line.serviceId);
    if (line.billingDisposition === 'paid') {
      if (line.selectedProviderCost === null || line.currency === null) {
        hold('BILLING_CYCLE_PAID_COST_MISSING');
      }
      if (line.currency !== expected.currency) hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
      const rated = rateProviderCost(line.selectedProviderCost, line.currency, {
        mode: tariff.mode.toLowerCase() as 'standard' | 'free' | 'at_cost' | 'custom',
        markupBps: effectiveMarkupBps(tariff, providerServiceRates, line.serviceId),
      });
      return { kind, charge: rated.total };
    } else if (line.selectedProviderCost !== null || line.currency !== null) {
      hold('BILLING_CYCLE_NONBILLABLE_COST_CONFLICT');
    }
    return { kind, charge: null };
  });
  const amount = (rows: typeof ratedLines) =>
    sumBillingDecimals(rows.flatMap((row) => row.charge === null ? [] : [row.charge]));
  const ratedAmount = amount(ratedLines);
  const baseId = `${expected.serviceIdentifier}\0${expected.teamId}\0${expected.billingMonth}`;
  // Without connected provider-service rates a team has exactly one usage line.
  const lines: BillingCycleUsageLine[] = [null, ...LINE_KINDS].flatMap((kind) => {
    const rows = ratedLines.filter((row) => row.kind === kind);
    if (rows.length === 0) return [];
    return [{
      id: kind ? `usage:${kind}:${createHash('sha256').update(`${baseId}\0${kind}`).digest('hex')}`
        : `usage:${createHash('sha256').update(baseId).digest('hex')}`,
      label: kindLabel(kind, false),
      usage_payment_mode: prepaid ? 'prepaid' as const : 'pay_as_you_go' as const,
      customer_charge: prepaid ? null : exactMoney(amount(rows), expected.currency),
      credits_consumed: null,
    }];
  });
  return { lines, ratedAmount, evidence: { team_id: expected.teamId,
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
  const creditsByMode = (lines: BillingCycleUsageLine[]): string | null => {
    if (lines.some((line) => line.credits_consumed === null)) return null;
    const microcredits = lines.reduce((sum, line) => {
      const value = line.credits_consumed;
      if (value === null || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
        hold('BILLING_CYCLE_CREDIT_SOURCE_CONFLICT');
      }
      const [whole, fraction = ''] = value.split('.');
      return sum + BigInt(whole ?? '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    }, 0n);
    return decimalCredits(microcredits);
  };
  // One line per payment mode, plus one per connected provider-service kind.
  return (['pay_as_you_go', 'prepaid'] as const).flatMap((mode) =>
    [null, ...LINE_KINDS].flatMap((kind) => {
      const lines = sourceLines.filter((line) =>
        line.usage_payment_mode === mode && cycleUsageLineKind(line) === kind);
      if (lines.length === 0) return [];
      const key = mode === 'prepaid' ? 'prepaid' : 'payg';
      const amount = sumBillingDecimals(lines.flatMap((line) =>
        line.customer_charge ? [line.customer_charge.amount] : []));
      return [{ id: kind ? `usage:organisation:${key}:${kind}` : `usage:organisation:${key}`,
        label: kindLabel(kind, mode === 'prepaid'), usage_payment_mode: mode,
        customer_charge: mode === 'prepaid' || !currency ? null : exactMoney(amount, currency),
        credits_consumed: creditsByMode(lines) }];
    }));
}

/** Assertion/cursor changes do not change the underlying financial receipts. */
export function cycleUsageContentFingerprint(rows: CycleUsageEvidence[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map((row) => ({
    team_id: row.team_id, content_sha256: row.content_sha256,
  })).sort((a, b) => compareBillingCycleUtf8(a.team_id, b.team_id)))).digest('hex');
}
