import type { BillingCreditAmount } from '../contracts/billing-statement-v1.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { formatBillingCopy } from './billing-copy-locale.js';
import { billingLocalizedCreditDisplay } from './billing-credit-copy.catalog.js';
import { billingCreditAmount } from './billing-credit-display.service.js';
import { billingCreditFundingCopy } from './billing-credit-funding-copy.catalog.js';
import type { BillingCreditActionReadiness } from './billing-credit-action-readiness.service.js';
import type { BillingCreditProjectionData } from './billing-credit-projection-data.service.js';
import type { CreditPurchaseRate } from './billing-credit-purchase-rate.service.js';

/** The subject a product relays unchanged in every credit action body. */
export type BillingCreditActionSubject = {
  product: string;
  organisation_id: string;
  team_id: string;
  user_id: string;
};

/** An offer can be acted on only while its exact catalog row is bound and its Stripe evidence is current. */
export function creditCatalogExecutable(
  data: BillingCreditProjectionData,
  offer: {
    catalogKey: string;
    catalogVersion: number;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
  },
  readiness: BillingCreditActionReadiness,
): boolean {
  const catalog = data.catalogs.find(
    (row) => row.key === offer.catalogKey && row.version === offer.catalogVersion,
  );
  return Boolean(
    catalog &&
    readiness.executableCatalogIds.has(catalog.id) &&
    catalog.stripeProductId &&
    catalog.stripePriceId &&
    catalog.paymentAmountMinor === offer.paymentAmountMinor &&
    catalog.creditsReceivedMicrocredits === offer.creditsReceivedMicrocredits,
  );
}

export function creditAmount(microcredits: bigint, locale?: BillingCustomerLocale): BillingCreditAmount {
  const amount = billingCreditAmount(microcredits, locale);
  return {
    ...amount,
    display: billingLocalizedCreditDisplay(amount.credits, locale),
  };
}

/** The live rate a GBP or EUR offer or reload option's credits follow. */
export function creditLiveRate(rate: CreditPurchaseRate, locale?: BillingCustomerLocale) {
  return {
    currency: rate.currency as 'EUR' | 'GBP',
    usd_per_unit: rate.baseRate,
    source: rate.source as 'stripe' | 'ecb',
    as_of: rate.asOf.toISOString(),
    display: formatBillingCopy(billingCreditFundingCopy(locale).liveRate, {
      currency: rate.currency, rate: Number(rate.baseRate).toFixed(4),
    }),
  };
}
