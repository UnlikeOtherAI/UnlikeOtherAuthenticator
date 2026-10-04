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
  cursor: string; sha256: string; captured_at: string; line_count: number } } {
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
    return {
      id: `usage:${id}`, service_id: line.serviceId, usage_unit: line.usageUnit,
      calls: line.calls,
      raw_units: { input: line.inputUnits, cached_input: line.cachedInputUnits,
        output: line.outputUnits,
        total: sumBillingDecimals([line.inputUnits, line.cachedInputUnits, line.outputUnits]) },
      customer_charge: customerCharge, credits_consumed: null,
    };
  });
  return { lines, evidence: { team_id: expected.teamId,
    snapshot_id: usage.snapshot.id, cursor: usage.snapshot.cursor,
    sha256: usage.snapshot.sha256, captured_at: usage.snapshot.capturedAt,
    line_count: lines.length } };
}
