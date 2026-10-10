import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingStatementCopy } from './billing-statement-copy.catalog.js';
import type { BillingStatementV1 } from '../contracts/billing-statement-v1.js';
import {
  addBillingDecimals,
  exactMoney,
} from './billing-money.service.js';
import { rateProviderCost } from './billing-rating.service.js';
import {
  effectiveMarkupBps,
  providerServiceLineKind,
  type ProviderServiceLineKind,
  type ProviderServiceRate,
} from './billing-provider-service-rate.service.js';
import {
  UNATTRIBUTED_BILLING_PRODUCT,
  type NormalizedMeteringUsage,
  type RawMeteringLine,
} from './billing-metering.types.js';

type RatingPlan = {
  product: string;
  mode: 'standard' | 'free' | 'at_cost' | 'custom';
  markupBps: number;
  // A connected provider-service rate rates that Ledger connector's lines and
  // shows them under their own commercial line.
  providerServiceRates?: readonly ProviderServiceRate[];
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
  providerServiceId: string,
  locale?: BillingCustomerLocale,
): UsageLine['customer_charge'] {
  if (!cost) return null;
  const rated = rateProviderCost(cost.amount, cost.currency, {
    mode: plan.mode,
    markupBps: effectiveMarkupBps(plan, plan.providerServiceRates ?? [], providerServiceId),
  });
  return exactMoney(rated.total, rated.currency, locale);
}

function serviceLines(metering: NormalizedMeteringUsage, plan: RatingPlan,
  locale?: BillingCustomerLocale): UsageLine[] {
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
      customer_charge: ratedCharge(cost, plan, line.serviceId, locale),
    };
  });
}

function chargeTotals(lines: UsageLine[], locale?: BillingCustomerLocale): ChargeTotal[] {
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
    .map(([currency, total]) => ({ currency, usage_charge: exactMoney(total, currency, locale) }));
}

function userTotals(
  metering: NormalizedMeteringUsage,
  plan: RatingPlan,
  users: UserIdentity[],
  locale?: BillingCustomerLocale,
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
      const lines = serviceLines({ ...metering, lines: rows, groupBy: 'user' }, plan, locale);
      const identity = identities.get(userId);
      return {
        user_id: userId,
        name: identity?.name ?? null,
        email: identity?.email ?? userId,
        charges: chargeTotals(lines, locale),
      };
    });
}

function lineCopy(kind: ProviderServiceLineKind | null, locale?: BillingCustomerLocale) {
  const copy = billingStatementCopy(locale);
  return kind === 'cloud_browser'
    ? { label: copy.cloudBrowser, detail: copy.cloudBrowserDetails }
    : { label: copy.meteredUsage, detail: copy.usageDetails };
}

/** One usage line per currency, plus one per connected provider-service line kind. */
function usageCommercialLines(metering: NormalizedMeteringUsage, lines: UsageLine[], plan: RatingPlan,
  locale?: BillingCustomerLocale): CommercialLine[] {
  const rates = plan.providerServiceRates ?? [];
  const kinds: (ProviderServiceLineKind | null)[] = [null, ...new Set(rates.map((rate) => rate.lineKind))];
  return kinds.flatMap((kind) => {
    const grouped = lines.filter((line, index) =>
      providerServiceLineKind(rates, metering.lines[index]?.serviceId ?? null) === kind);
    return chargeTotals(grouped, locale).map((total) => ({
      id: kind ? `usage_${kind}_${total.currency}` : `usage_${total.currency}`,
      kind: 'usage' as const,
      product: plan.product,
      ...lineCopy(kind, locale),
      amount: total.usage_charge,
    }));
  });
}

export function rateBillingStatementUsage(params: {
  serviceMetering: NormalizedMeteringUsage;
  userMetering: NormalizedMeteringUsage;
  plan: RatingPlan;
  users: UserIdentity[];
  locale?: BillingCustomerLocale;
}): {
  usage: BillingStatementV1['usage'];
  commercialLines: CommercialLine[];
} {
  const lines = serviceLines(params.serviceMetering, params.plan, params.locale);
  const charges = chargeTotals(lines, params.locale);
  return {
    usage: {
      lines,
      charge_totals: charges,
      user_totals: userTotals(params.userMetering, params.plan, params.users, params.locale),
    },
    commercialLines: usageCommercialLines(params.serviceMetering, lines, params.plan, params.locale),
  };
}

export function billingCommercialTotals(
  lines: BillingStatementV1['commercial_lines'],
  locale?: BillingCustomerLocale,
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
      monthly: exactMoney(parts.monthly, currency, locale),
      usage: exactMoney(parts.usage, currency, locale),
      add_ons: exactMoney(parts.addOns, currency, locale),
      credits: exactMoney(parts.credits, currency, locale),
      total_due: exactMoney(
        [parts.monthly, parts.usage, parts.addOns, parts.credits].reduce(addBillingDecimals, '0'),
        currency, locale,
      ),
    }));
}
