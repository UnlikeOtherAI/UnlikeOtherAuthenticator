import type { BillingStatementV1 } from '../contracts/billing-statement-v1.js';
import {
  addBillingDecimals,
  exactMoney,
  multiplyBillingDecimalByBps,
  sumBillingDecimals,
} from './billing-money.service.js';
import { rateProviderCost, usagePriceMultiplierBps } from './billing-rating.service.js';
import {
  UNATTRIBUTED_BILLING_PRODUCT,
  type NormalizedMeteringUsage,
  type RawMeteringLine,
} from './billing-metering.types.js';

type RatingPlan = {
  product: string;
  mode: 'standard' | 'free' | 'at_cost' | 'custom';
  markupBps: number;
};

type UserIdentity = {
  id: string;
  name: string | null;
  email: string;
};

type UsageLine = BillingStatementV1['usage']['lines'][number];
type CostTotal = BillingStatementV1['usage']['cost_totals'][number];
type CommercialLine = BillingStatementV1['commercial_lines'][number];

function usageMultiplierBps(plan: RatingPlan): number {
  return usagePriceMultiplierBps({ mode: plan.mode, markupBps: plan.markupBps });
}

function rawUnits(line: RawMeteringLine) {
  const total = sumBillingDecimals([line.inputUnits, line.cachedInputUnits, line.outputUnits]);
  return {
    input: line.inputUnits,
    cached_input: line.cachedInputUnits,
    output: line.outputUnits,
    total,
  };
}

function billableUnits(line: RawMeteringLine, multiplierBps: number) {
  const raw = rawUnits(line);
  return {
    input: multiplyBillingDecimalByBps(raw.input, multiplierBps),
    cached_input: multiplyBillingDecimalByBps(raw.cached_input, multiplierBps),
    output: multiplyBillingDecimalByBps(raw.output, multiplierBps),
    total: multiplyBillingDecimalByBps(raw.total, multiplierBps),
  };
}

function selectedProviderCost(line: RawMeteringLine): {
  amount: string;
  currency: string;
  provenance: string;
} | null {
  if (!line.currency || line.selectedProviderCost === null) return null;
  return {
    amount: line.selectedProviderCost,
    currency: line.currency,
    provenance: line.costProvenance ?? 'provider_selected',
  };
}

function ratedCharge(
  cost: ReturnType<typeof selectedProviderCost>,
  plan: RatingPlan,
): UsageLine['rated_charge'] {
  if (!cost) return null;
  const rated = rateProviderCost(cost.amount, cost.currency, {
    mode: plan.mode,
    markupBps: plan.markupBps,
  });
  return {
    base: exactMoney(rated.base, rated.currency),
    markup: exactMoney(rated.markup, rated.currency),
    total: exactMoney(rated.total, rated.currency),
  };
}

function shareBasisPoints(lineTotal: string, unitTotal: string): number {
  const total = BigInt(unitTotal);
  if (total === 0n) return 0;
  const value = BigInt(lineTotal);
  return Number((value * 10_000n + total / 2n) / total);
}

function formatPercent(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

function serviceLines(metering: NormalizedMeteringUsage, plan: RatingPlan): UsageLine[] {
  const rawTotalsByUnit = new Map<string, string>();
  for (const line of metering.lines) {
    rawTotalsByUnit.set(
      line.usageUnit,
      addBillingDecimals(rawTotalsByUnit.get(line.usageUnit) ?? '0', rawUnits(line).total),
    );
  }

  return metering.lines.map((line, index) => {
    const raw = rawUnits(line);
    const basisPoints = shareBasisPoints(raw.total, rawTotalsByUnit.get(line.usageUnit) ?? '0');
    const cost = selectedProviderCost(line);
    return {
      id: `usage_${index + 1}`,
      service_id: line.serviceId,
      usage_unit: line.usageUnit,
      calls: line.calls,
      attribution: {
        user_id: line.userId,
        billing_product: line.billingProduct,
        caller_product: line.callerProduct ?? UNATTRIBUTED_BILLING_PRODUCT,
        origin_product: line.originProduct ?? UNATTRIBUTED_BILLING_PRODUCT,
      },
      raw_units: raw,
      billable_units: billableUnits(line, usageMultiplierBps(plan)),
      share: {
        basis_points: basisPoints,
        percent: formatPercent(basisPoints),
        display: `${formatPercent(basisPoints)}% of ${line.usageUnit} usage`,
      },
      provider_cost: cost
        ? { ...exactMoney(cost.amount, cost.currency), provenance: cost.provenance }
        : null,
      rated_charge: ratedCharge(cost, plan),
    };
  });
}

function usageTotals(lines: UsageLine[]): BillingStatementV1['usage']['totals'] {
  const totals = new Map<string, { raw: string; billable: string }>();
  for (const line of lines) {
    const current = totals.get(line.usage_unit) ?? { raw: '0', billable: '0' };
    totals.set(line.usage_unit, {
      raw: addBillingDecimals(current.raw, line.raw_units.total),
      billable: addBillingDecimals(current.billable, line.billable_units.total),
    });
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([usageUnit, total]) => ({
      usage_unit: usageUnit,
      raw_units: total.raw,
      billable_units: total.billable,
      display: `${total.billable} billable ${usageUnit} (${total.raw} raw)`,
    }));
}

function costTotals(lines: UsageLine[]): CostTotal[] {
  const totals = new Map<string, { providerCost: string; markup: string; usageCharge: string }>();
  for (const line of lines) {
    if (!line.provider_cost || !line.rated_charge) continue;
    const currency = line.provider_cost.currency;
    const current = totals.get(currency) ?? {
      providerCost: '0',
      markup: '0',
      usageCharge: '0',
    };
    totals.set(currency, {
      providerCost: addBillingDecimals(current.providerCost, line.provider_cost.amount),
      markup: addBillingDecimals(current.markup, line.rated_charge.markup.amount),
      usageCharge: addBillingDecimals(current.usageCharge, line.rated_charge.total.amount),
    });
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => ({
      currency,
      provider_cost: exactMoney(total.providerCost, currency),
      markup: exactMoney(total.markup, currency),
      usage_charge: exactMoney(total.usageCharge, currency),
    }));
}

function userTotals(
  metering: NormalizedMeteringUsage,
  plan: RatingPlan,
  users: UserIdentity[],
): BillingStatementV1['usage']['user_totals'] {
  const identities = new Map(users.map((user) => [user.id, user]));
  const byUser = new Map<string, RawMeteringLine[]>();
  for (const line of metering.lines) {
    if (!line.userId) continue;
    const rows = byUser.get(line.userId) ?? [];
    rows.push(line);
    byUser.set(line.userId, rows);
  }
  return [...byUser.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([userId, rows]) => {
      const lines = serviceLines({ ...metering, lines: rows, groupBy: 'user' }, plan);
      const identity = identities.get(userId);
      return {
        user_id: userId,
        name: identity?.name ?? null,
        email: identity?.email ?? userId,
        calls: sumBillingDecimals(rows.map((row) => row.calls)),
        usage: usageTotals(lines).map((total) => ({
          usage_unit: total.usage_unit,
          raw_units: total.raw_units,
          billable_units: total.billable_units,
        })),
        costs: costTotals(lines),
      };
    });
}

function usageCommercialLines(totals: CostTotal[], plan: RatingPlan): CommercialLine[] {
  return totals.map((total) => ({
    id: `usage_${total.currency}`,
    kind: 'usage',
    product: plan.product,
    label: 'Metered usage',
    detail:
      plan.mode === 'free'
        ? `Usage value ${total.provider_cost.display}; free tariff`
        : `Provider cost ${total.provider_cost.display} + ${(plan.markupBps / 100).toFixed(
            2,
          )}% (${total.markup.display})`,
    amount: total.usage_charge,
  }));
}

export function rateBillingStatementUsage(params: {
  serviceMetering: NormalizedMeteringUsage;
  userMetering: NormalizedMeteringUsage;
  plan: RatingPlan;
  users: UserIdentity[];
}): {
  usage: BillingStatementV1['usage'];
  commercialLines: CommercialLine[];
} {
  const lines = serviceLines(params.serviceMetering, params.plan);
  const totals = usageTotals(lines);
  const costs = costTotals(lines);
  return {
    usage: {
      lines,
      totals,
      cost_totals: costs,
      user_totals: userTotals(params.userMetering, params.plan, params.users),
    },
    commercialLines: usageCommercialLines(costs, params.plan),
  };
}
