import type { NormalizedMeteringPortfolio, NormalizedMeteringUsage } from './billing-metering.types.js';
import { sumBillingDecimals } from './billing-money.service.js';

/** Select only the requested product before private provider usage is rated. */
export function filterPortfolioForProduct(
  portfolio: NormalizedMeteringPortfolio,
  product: string,
): NormalizedMeteringUsage {
  const lines = portfolio.lines.filter((line) => line.billingProduct === product);
  return {
    schemaVersion: 1,
    product,
    groupBy: portfolio.groupBy,
    scope: { ...portfolio.scope, userId: null },
    calls: sumBillingDecimals(lines.map((line) => line.calls)),
    lines,
    billingCompleteness: portfolio.billingCompleteness,
    snapshot: portfolio.snapshot,
  };
}
