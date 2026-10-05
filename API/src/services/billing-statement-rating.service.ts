import type { BillingStatementV1 } from '../contracts/billing-statement-v1.js';
import {
  addBillingDecimals,
  exactMoney,
} from './billing-money.service.js';
import { rateProviderCost } from './billing-rating.service.js';
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
  email: string | null;
};

type UsageLine = BillingStatementV1['usage']['lines'][number];
type ChargeTotal = BillingStatementV1['usage']['charge_totals'][number];
type CommercialLine = BillingStatementV1['commercial_lines'][number];

function selectedProviderCost(line: RawMeteringLine): {
  amount: string;
  currency: string;
} | null {
  if (!line.currency || line.selectedProviderCost === null) return null;
  return {
    amount: line.selectedProviderCost,
    currency: line.currency,
  };
}

function ratedCharge(
  cost: ReturnType<typeof selectedProviderCost>,
  plan: RatingPlan,
): UsageLine['customer_charge'] {
  if (!cost) return null;
  const rated = rateProviderCost(cost.amount, cost.currency, {
    mode: plan.mode,
    markupBps: plan.markupBps,
  });
  return exactMoney(rated.total, rated.currency);
}

function serviceLines(metering: NormalizedMeteringUsage, plan: RatingPlan): UsageLine[] {
  return metering.lines.map((line, index) => {
    const cost = selectedProviderCost(line);
    return {
      id: `usage_${index + 1}`,
      attribution: {
        user_id: line.userId,
        billing_product: line.billingProduct,
        caller_product: line.callerProduct ?? UNATTRIBUTED_BILLING_PRODUCT,
        origin_product: line.originProduct ?? UNATTRIBUTED_BILLING_PRODUCT,
      },
      customer_charge: ratedCharge(cost, plan),
    };
  });
}

function chargeTotals(lines: UsageLine[]): ChargeTotal[] {
  const totals = new Map<string, string>();
  for (const line of lines) {
    if (!line.customer_charge) continue;
    const currency = line.customer_charge.currency;
    totals.set(
      currency,
      addBillingDecimals(totals.get(currency) ?? '0', line.customer_charge.amount),
    );
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => ({ currency, usage_charge: exactMoney(total, currency) }));
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
        charges: chargeTotals(lines),
      };
    });
}

function usageCommercialLines(totals: ChargeTotal[], plan: RatingPlan): CommercialLine[] {
  return totals.map((total) => ({
    id: `usage_${total.currency}`,
    kind: 'usage',
    product: plan.product,
    label: 'Metered usage',
    detail: 'Metered usage charge for this billing period',
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
  const charges = chargeTotals(lines);
  return {
    usage: {
      lines,
      charge_totals: charges,
      user_totals: userTotals(params.userMetering, params.plan, params.users),
    },
    commercialLines: usageCommercialLines(charges, params.plan),
  };
}

export function billingCommercialTotals(
  lines: BillingStatementV1['commercial_lines'],
): BillingStatementV1['totals'] {
  type Parts = {
    monthly: string;
    usage: string;
    addOns: string;
    credits: string;
  };
  const byCurrency = new Map<string, Parts>();
  for (const line of lines) {
    const current = byCurrency.get(line.amount.currency) ?? {
      monthly: '0',
      usage: '0',
      addOns: '0',
      credits: '0',
    };
    const key =
      line.kind === 'monthly_subscription'
        ? 'monthly'
        : line.kind === 'usage'
          ? 'usage'
          : line.kind === 'add_on'
            ? 'addOns'
            : 'credits';
    current[key] = addBillingDecimals(current[key], line.amount.amount);
    byCurrency.set(line.amount.currency, current);
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, parts]) => ({
      currency,
      monthly: exactMoney(parts.monthly, currency),
      usage: exactMoney(parts.usage, currency),
      add_ons: exactMoney(parts.addOns, currency),
      credits: exactMoney(parts.credits, currency),
      total_due: exactMoney(
        [parts.monthly, parts.usage, parts.addOns, parts.credits].reduce(addBillingDecimals, '0'),
        currency,
      ),
    }));
}
