import { createHash } from 'node:crypto';

import type { BillingTariff } from '@prisma/client';

import type { BillingCycleUsageLine } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { sumBillingDecimals } from './billing-money.service.js';
import {
  meteringIsComplete, type NormalizedMeteringUsage,
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
  content_sha256: string } } {
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
  const lines: BillingCycleUsageLine[] = usage.lines.map((line, index) => {
    if (line.billingProduct !== expected.serviceIdentifier) {
      hold('BILLING_CYCLE_LEDGER_PRODUCT_MISMATCH');
    }
    let customerCharge: BillingCycleUsageLine['customer_charge'] = null;
    if (line.billingDisposition === 'paid') {
      if (line.selectedProviderCost === null || line.currency === null) {
        hold('BILLING_CYCLE_PAID_COST_MISSING');
      }
      if (line.currency !== expected.currency) hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
      const rated = rateProviderCost(line.selectedProviderCost, line.currency, {
        mode: tariff.mode.toLowerCase() as 'standard' | 'free' | 'at_cost' | 'custom',
        markupBps: tariff.markupBps,
      });
      customerCharge = exactMoney(rated.total, rated.currency);
    } else if (line.selectedProviderCost !== null || line.currency !== null) {
      hold('BILLING_CYCLE_NONBILLABLE_COST_CONFLICT');
    }
    const id = createHash('sha256').update(`${usage.snapshot.id}\0${index}`).digest('hex');
    const raw = line.breakdown;
    const fiveMinute = raw?.cacheWrite5mTokens;
    const oneHour = raw?.cacheWrite1hTokens;
    if ((fiveMinute === undefined) !== (oneHour === undefined)) {
      hold('BILLING_CYCLE_CACHE_WRITE_EVIDENCE_INCOMPLETE');
    }
    const cacheWrite = fiveMinute !== undefined && oneHour !== undefined
      ? sumBillingDecimals([fiveMinute, oneHour]) : undefined;
    const modalityFields = [
      ['input_text', raw?.inputTextTokens], ['input_image', raw?.inputImageTokens],
      ['input_audio', raw?.inputAudioTokens], ['output_image', raw?.outputImageTokens],
      ['output_audio', raw?.outputAudioTokens], ['cached_image', raw?.cachedImageTokens],
      ['cached_audio', raw?.cachedAudioTokens], ['tool_use_input', raw?.toolUseInputTokens],
      ['raw_input', raw?.rawInputTokens], ['raw_output', raw?.rawOutputTokens],
      ['unattributed', raw?.unattributedTokens],
    ] as const;
    const modalities = modalityFields.flatMap(([modality, rawUnits]) =>
      rawUnits === undefined ? [] : [{ modality, raw_units: rawUnits }]);
    return {
      id: `usage:${id}`, service_id: line.serviceId, usage_unit: line.usageUnit,
      calls: line.calls,
      raw_units: { input: line.inputUnits, cached_input: line.cachedInputUnits,
        output: line.outputUnits,
        total: sumBillingDecimals([line.inputUnits, line.cachedInputUnits,
          line.outputUnits, ...(cacheWrite === undefined ? [] : [cacheWrite])]),
        ...(raw?.thoughtOutputTokens === undefined ? {} :
          { reasoning: raw.thoughtOutputTokens }),
        ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite,
          cache_write_5m: fiveMinute, cache_write_1h: oneHour }),
      },
      ...(modalities.length === 0 ? {} : { modalities }),
      customer_charge: customerCharge, credits_consumed: null,
    };
  });
  return { lines, evidence: { team_id: expected.teamId,
    snapshot_id: usage.snapshot.id, cursor: usage.snapshot.cursor,
    sha256: usage.snapshot.sha256, captured_at: usage.snapshot.capturedAt,
    line_count: lines.length, content_sha256: contentSha256 } };
}

export type CycleUsageEvidence = ReturnType<typeof projectCycleUsage>['evidence'];

/** Assertion/cursor changes do not change the underlying financial receipts. */
export function cycleUsageContentFingerprint(rows: CycleUsageEvidence[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map((row) => ({
    team_id: row.team_id, content_sha256: row.content_sha256,
  })).sort((a, b) => a.team_id.localeCompare(b.team_id)))).digest('hex');
}
