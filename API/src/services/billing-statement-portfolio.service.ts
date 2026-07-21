import type {
  BillingConnectedServicePortfolio,
  BillingPortfolioCostContribution,
  BillingPortfolioCostTotal,
  BillingPortfolioUsageContribution,
  BillingPortfolioUsageTotal,
  BillingStatementV2,
  BillingUsageShare,
} from '../contracts/billing-statement-v1.js';
import {
  addBillingDecimals,
  billingDecimalRatioBasisPoints,
  exactMoney,
  sumBillingDecimals,
} from './billing-money.service.js';
import type {
  NormalizedMeteringPortfolio,
  NormalizedMeteringUsage,
  RawMeteringLine,
} from './billing-metering.types.js';
import type { DirectBillingServiceAccess } from './billing-service-access.service.js';

type ProductIdentity = { identifier: string; name: string };
type UserIdentity = { id: string; name: string | null; email: string };
type PortfolioService = BillingStatementV2['connected_service_usage']['services'][number];

function rawTotal(line: RawMeteringLine): string {
  return sumBillingDecimals([line.inputUnits, line.cachedInputUnits, line.outputUnits]);
}

function selectedCost(line: RawMeteringLine): { amount: string; currency: string } | null {
  if (!line.currency || line.selectedProviderCost === null) return null;
  return { amount: line.selectedProviderCost, currency: line.currency };
}

function groupLines<Key>(
  lines: RawMeteringLine[],
  key: (line: RawMeteringLine) => Key,
): Map<Key, RawMeteringLine[]> {
  const grouped = new Map<Key, RawMeteringLine[]>();
  for (const line of lines) {
    const value = key(line);
    const bucket = grouped.get(value);
    if (bucket) bucket.push(line);
    else grouped.set(value, [line]);
  }
  return grouped;
}

function usageTotals(lines: RawMeteringLine[]): Map<string, string> {
  const totals = new Map<string, string>();
  for (const line of lines) {
    totals.set(
      line.usageUnit,
      addBillingDecimals(totals.get(line.usageUnit) ?? '0', rawTotal(line)),
    );
  }
  return totals;
}

function costTotals(lines: RawMeteringLine[]): Map<string, string> {
  const totals = new Map<string, string>();
  for (const line of lines) {
    const cost = selectedCost(line);
    if (!cost) continue;
    totals.set(cost.currency, addBillingDecimals(totals.get(cost.currency) ?? '0', cost.amount));
  }
  return totals;
}

function displayInteger(value: string): string {
  return BigInt(value).toLocaleString('en-GB');
}

function percentage(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

function share(part: string, total: string, label: string): BillingUsageShare {
  const basisPoints = billingDecimalRatioBasisPoints(part, total) ?? 0;
  const percent = percentage(basisPoints);
  return { basis_points: basisPoints, percent, display: `${percent}% of ${label}` };
}

function usageTotalRows(lines: RawMeteringLine[]): BillingPortfolioUsageTotal[] {
  return [...usageTotals(lines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([usageUnit, rawUnits]) => ({
      usage_unit: usageUnit,
      raw_units: rawUnits,
      display: `${displayInteger(rawUnits)} raw ${usageUnit} across this team`,
    }));
}

function costTotalRows(lines: RawMeteringLine[]): BillingPortfolioCostTotal[] {
  return [...costTotals(lines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => {
      const providerCost = exactMoney(amount, currency);
      return {
        currency,
        provider_cost: providerCost,
        display: `${providerCost.display} raw provider cost across this team`,
      };
    });
}

function usageContributionRows(
  lines: RawMeteringLine[],
  serviceLines: RawMeteringLine[],
  contributorName: string,
  serviceName: string,
): BillingPortfolioUsageContribution[] {
  const contributor = usageTotals(lines);
  return [...usageTotals(serviceLines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([usageUnit, total]) => {
      const rawUnits = contributor.get(usageUnit) ?? '0';
      const unitShare = share(rawUnits, total, `${serviceName} ${usageUnit}`);
      return {
        usage_unit: usageUnit,
        raw_units: rawUnits,
        share: unitShare,
        display: `${contributorName} used ${displayInteger(rawUnits)} raw ${usageUnit} (${unitShare.percent}%)`,
      };
    });
}

function costContributionRows(
  lines: RawMeteringLine[],
  serviceLines: RawMeteringLine[],
  contributorName: string,
  serviceName: string,
): BillingPortfolioCostContribution[] {
  const contributor = costTotals(lines);
  return [...costTotals(serviceLines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => {
      const amount = contributor.get(currency) ?? '0';
      const providerCost = exactMoney(amount, currency);
      const basisPoints = billingDecimalRatioBasisPoints(amount, total);
      const costShare =
        basisPoints === null
          ? null
          : {
              basis_points: basisPoints,
              percent: percentage(basisPoints),
              display: `${percentage(basisPoints)}% of ${serviceName} ${currency} provider cost`,
            };
      return {
        currency,
        provider_cost: providerCost,
        share: costShare,
        display: costShare
          ? `${contributorName} used ${providerCost.display} raw provider cost (${costShare.percent}%)`
          : `${contributorName} used ${providerCost.display} raw provider cost; share unavailable after corrections`,
      };
    });
}

function originRows(params: {
  lines: RawMeteringLine[];
  statementProduct: string;
  serviceName: string;
  productNames: Map<string, string>;
}): PortfolioService['origins'] {
  const byOrigin = groupLines(params.lines, (line) => line.originProduct);
  if (!byOrigin.has(params.statementProduct)) byOrigin.set(params.statementProduct, []);
  const calls = sumBillingDecimals(params.lines.map((line) => line.calls));
  return [...byOrigin.entries()]
    .sort(([left], [right]) => {
      if (left === params.statementProduct) return -1;
      if (right === params.statementProduct) return 1;
      if (left === null) return 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map(([product, lines]) => {
      const name = product === null ? null : (params.productNames.get(product) ?? null);
      const displayName = product === null ? 'Unattributed origin' : (name ?? product);
      const originCalls = sumBillingDecimals(lines.map((line) => line.calls));
      return {
        product,
        name,
        display_name: displayName,
        is_statement_product: product === params.statementProduct,
        calls: originCalls,
        call_share: share(originCalls, calls, `${params.serviceName} calls`),
        usage: usageContributionRows(lines, params.lines, displayName, params.serviceName),
        provider_costs: costContributionRows(lines, params.lines, displayName, params.serviceName),
      };
    });
}

function userRows(params: {
  lines: RawMeteringLine[];
  serviceName: string;
  users: Map<string, UserIdentity>;
}): PortfolioService['users'] {
  const byUser = groupLines(params.lines, (line) => line.userId);
  const calls = sumBillingDecimals(params.lines.map((line) => line.calls));
  return [...byUser.entries()]
    .sort(([left], [right]) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map(([userId, lines]) => {
      const identity = userId ? params.users.get(userId) : undefined;
      const displayName = identity?.name ?? identity?.email ?? userId ?? 'Unattributed usage';
      const userCalls = sumBillingDecimals(lines.map((line) => line.calls));
      return {
        user_id: userId,
        name: identity?.name ?? null,
        email: identity?.email ?? null,
        display_name: displayName,
        calls: userCalls,
        call_share: share(userCalls, calls, `${params.serviceName} calls`),
        usage: usageContributionRows(lines, params.lines, displayName, params.serviceName),
        provider_costs: costContributionRows(lines, params.lines, displayName, params.serviceName),
      };
    });
}

function serviceDescription(
  serviceName: string,
  statementProductName: string,
  totals: BillingPortfolioUsageTotal[],
  statementOrigin: PortfolioService['origins'][number],
): string {
  if (totals.length === 0) return `${serviceName} had no metered team usage in this period.`;
  const usage = totals
    .map((total) => `${displayInteger(total.raw_units)} ${total.usage_unit}`)
    .join(', ');
  const contribution = statementOrigin.usage
    .map((item) => `${item.share.percent}% of ${item.usage_unit}`)
    .join(', ');
  return `${serviceName} recorded ${usage} across this team. ${statementProductName} originated ${contribution}. Other-service usage is informational and does not change this statement total.`;
}

export function filterPortfolioForProduct(
  portfolio: NormalizedMeteringPortfolio,
  product: string,
): NormalizedMeteringUsage {
  return {
    schemaVersion: 1,
    product,
    groupBy: portfolio.groupBy,
    scope: { ...portfolio.scope, userId: null },
    calls: sumBillingDecimals(
      portfolio.lines.filter((line) => line.billingProduct === product).map((line) => line.calls),
    ),
    lines: portfolio.lines.filter((line) => line.billingProduct === product),
    snapshot: portfolio.snapshot,
  };
}

export function buildConnectedServicePortfolio(params: {
  statementProduct: string;
  userMetering: NormalizedMeteringPortfolio;
  products: ProductIdentity[];
  accesses: DirectBillingServiceAccess[];
  users: UserIdentity[];
}): BillingConnectedServicePortfolio {
  const productNames = new Map(
    params.products.map((product) => [product.identifier, product.name]),
  );
  const accessByProduct = new Map(params.accesses.map((access) => [access.product, access]));
  const users = new Map(params.users.map((user) => [user.id, user]));
  const serviceLines = groupLines(params.userMetering.lines, (line) => line.billingProduct);
  if (!serviceLines.has(params.statementProduct)) serviceLines.set(params.statementProduct, []);
  for (const access of params.accesses) {
    if (!serviceLines.has(access.product)) serviceLines.set(access.product, []);
  }
  const statementProductName = productNames.get(params.statementProduct) ?? params.statementProduct;
  const services = [...serviceLines.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([billingProduct, lines]) => {
      const access = accessByProduct.get(billingProduct);
      const name = productNames.get(billingProduct) ?? access?.name ?? null;
      const displayName = name ?? billingProduct;
      const origins = originRows({
        lines,
        statementProduct: params.statementProduct,
        serviceName: displayName,
        productNames,
      });
      const totals = usageTotalRows(lines);
      return {
        billing_product: billingProduct,
        name,
        display_name: displayName,
        access: access ? ('direct' as const) : ('indirect' as const),
        direct_user_count: access?.userIds.length ?? 0,
        title: `${displayName} team usage`,
        description: serviceDescription(
          displayName,
          statementProductName,
          totals,
          origins.find(
            (origin) => origin.is_statement_product,
          ) as PortfolioService['origins'][number],
        ),
        totals: {
          calls: sumBillingDecimals(lines.map((line) => line.calls)),
          usage: totals,
          provider_costs: costTotalRows(lines),
        },
        origins,
        users: userRows({
          lines,
          serviceName: displayName,
          users,
        }),
      };
    });
  return {
    title: 'Connected-service usage',
    description:
      'Team-wide raw usage across connected services. Other services are shown for transparency and are not added to this statement total.',
    statement_product: params.statementProduct,
    services,
  };
}
