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
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import {
  billingStatementCopy,
  billingStatementText,
  billingStatementUsageUnit,
} from './billing-statement-copy.catalog.js';

type ProductIdentity = { identifier: string; name: string };
type UserIdentity = { id: string; name: string | null; email: string | null };
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

function displayInteger(value: string, locale?: BillingCustomerLocale): string {
  return BigInt(value).toLocaleString(locale ?? 'en-GB');
}

function percentage(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

function displayPercentage(basisPoints: number, locale?: BillingCustomerLocale): string {
  return new Intl.NumberFormat(locale ?? 'en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(basisPoints / 100);
}

function share(
  part: string,
  total: string,
  label: string,
  locale?: BillingCustomerLocale,
): BillingUsageShare {
  const basisPoints = billingDecimalRatioBasisPoints(part, total) ?? 0;
  const percent = percentage(basisPoints);
  return {
    basis_points: basisPoints,
    percent,
    display: billingStatementText(billingStatementCopy(locale).share, {
      percent: displayPercentage(basisPoints, locale), label,
    }),
  };
}

function usageTotalRows(
  lines: RawMeteringLine[],
  locale?: BillingCustomerLocale,
): BillingPortfolioUsageTotal[] {
  return [...usageTotals(lines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([usageUnit, rawUnits]) => ({
      usage_unit: usageUnit,
      raw_units: rawUnits,
      display: billingStatementText(billingStatementCopy(locale).rawTeamUsage, {
        count: displayInteger(rawUnits, locale), unit: billingStatementUsageUnit(usageUnit, locale),
      }),
    }));
}

function costTotalRows(
  lines: RawMeteringLine[],
  locale?: BillingCustomerLocale,
): BillingPortfolioCostTotal[] {
  return [...costTotals(lines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => {
      const providerCost = exactMoney(amount, currency);
      return {
        currency,
        provider_cost: providerCost,
        display: billingStatementText(billingStatementCopy(locale).rawProviderCost, {
          amount: providerCost.display,
        }),
      };
    });
}

function usageContributionRows(
  lines: RawMeteringLine[],
  serviceLines: RawMeteringLine[],
  contributorName: string,
  serviceName: string,
  locale?: BillingCustomerLocale,
): BillingPortfolioUsageContribution[] {
  const contributor = usageTotals(lines);
  return [...usageTotals(serviceLines).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([usageUnit, total]) => {
      const rawUnits = contributor.get(usageUnit) ?? '0';
      const copy = billingStatementCopy(locale);
      const displayUnit = billingStatementUsageUnit(usageUnit, locale);
      const unitShare = share(rawUnits, total, billingStatementText(copy.usageShareLabel, { unit: displayUnit }), locale);
      return {
        usage_unit: usageUnit,
        raw_units: rawUnits,
        share: unitShare,
        display: billingStatementText(billingStatementCopy(locale).usageContribution, {
          name: contributorName,
          count: displayInteger(rawUnits, locale),
          unit: displayUnit,
          percent: unitShare.percent,
        }),
      };
    });
}

function costContributionRows(
  lines: RawMeteringLine[],
  serviceLines: RawMeteringLine[],
  contributorName: string,
  serviceName: string,
  locale?: BillingCustomerLocale,
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
              display: billingStatementText(billingStatementCopy(locale).providerCostShare, {
                percent: displayPercentage(basisPoints, locale), service: serviceName, currency,
              }),
            };
      return {
        currency,
        provider_cost: providerCost,
        share: costShare,
        display: costShare
          ? billingStatementText(billingStatementCopy(locale).providerCostContribution, {
            name: contributorName, amount: providerCost.display,
            percent: displayPercentage(costShare.basis_points, locale),
          })
          : billingStatementText(billingStatementCopy(locale).providerCostContributionUnavailable, {
            name: contributorName, amount: providerCost.display,
          }),
      };
    });
}

function originRows(params: {
  lines: RawMeteringLine[];
  statementProduct: string;
  serviceName: string;
  productNames: Map<string, string>;
  locale?: BillingCustomerLocale;
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
      const displayName = product === null
        ? billingStatementCopy(params.locale).unattributedOrigin
        : (name ?? product);
      const originCalls = sumBillingDecimals(lines.map((line) => line.calls));
      return {
        product,
        name,
        display_name: displayName,
        is_statement_product: product === params.statementProduct,
        calls: originCalls,
        call_share: share(originCalls, calls, billingStatementText(
          billingStatementCopy(params.locale).callsShareLabel,
          { name: params.serviceName },
        ), params.locale),
        usage: usageContributionRows(lines, params.lines, displayName, params.serviceName, params.locale),
        provider_costs: costContributionRows(lines, params.lines, displayName, params.serviceName, params.locale),
      };
    });
}

function userRows(params: {
  lines: RawMeteringLine[];
  serviceName: string;
  users: Map<string, UserIdentity>;
  locale?: BillingCustomerLocale;
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
      const displayName = identity?.name ?? identity?.email ?? userId
        ?? billingStatementCopy(params.locale).unattributedUsage;
      const userCalls = sumBillingDecimals(lines.map((line) => line.calls));
      return {
        user_id: userId,
        name: identity?.name ?? null,
        email: identity?.email ?? null,
        display_name: displayName,
        calls: userCalls,
        call_share: share(userCalls, calls, billingStatementText(
          billingStatementCopy(params.locale).callsShareLabel,
          { name: params.serviceName },
        ), params.locale),
        usage: usageContributionRows(lines, params.lines, displayName, params.serviceName, params.locale),
        provider_costs: costContributionRows(lines, params.lines, displayName, params.serviceName, params.locale),
      };
    });
}

function serviceDescription(
  serviceName: string,
  statementProductName: string,
  totals: BillingPortfolioUsageTotal[],
  statementOrigin: PortfolioService['origins'][number],
  locale?: BillingCustomerLocale,
): string {
  const copy = billingStatementCopy(locale);
  if (totals.length === 0) return `${serviceName}. ${copy.noUsage}`;
  const usage = totals
    .map((total) => `${displayInteger(total.raw_units, locale)} ${billingStatementUsageUnit(total.usage_unit, locale)}`)
    .join(', ');
  const contribution = statementOrigin.usage
    .map((item) => billingStatementText(copy.usageShareSummary, {
      percent: displayPercentage(item.share.basis_points, locale),
      unit: billingStatementUsageUnit(item.usage_unit, locale),
    }))
    .join(', ');
  return `${billingStatementText(copy.recordedUsage, {
    usage, product: statementProductName, contribution,
  })} ${copy.otherServiceUsage}`;
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
  locale?: BillingCustomerLocale;
}): BillingConnectedServicePortfolio {
  const copy = billingStatementCopy(params.locale);
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
        locale: params.locale,
      });
      const totals = usageTotalRows(lines, params.locale);
      return {
        billing_product: billingProduct,
        name,
        display_name: displayName,
        access: access ? ('direct' as const) : ('indirect' as const),
        direct_user_count: access?.userIds.length ?? 0,
        title: billingStatementText(copy.teamUsageTitle, { name: displayName }),
        description: serviceDescription(
          displayName,
          statementProductName,
          totals,
          origins.find(
            (origin) => origin.is_statement_product,
          ) as PortfolioService['origins'][number],
          params.locale,
        ),
        totals: {
          calls: sumBillingDecimals(lines.map((line) => line.calls)),
          usage: totals,
          provider_costs: costTotalRows(lines, params.locale),
        },
        origins,
        users: userRows({
          lines,
          serviceName: displayName,
          users,
          locale: params.locale,
        }),
      };
    });
  return {
    title: copy.portfolioTitle,
    description: copy.portfolioDescription,
    statement_product: params.statementProduct,
    services,
  };
}
