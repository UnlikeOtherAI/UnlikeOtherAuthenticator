import type { BillingCycleDetailV2, BillingOrganisationFinancialDto } from '../contracts/billing-statement-v1.js';
import { billingLocale,type BillingCustomerLocale } from './billing-copy-locale.js';
import { localizedBillingMoney } from './billing-money.service.js';
import { billingStatementCopy } from './billing-statement-copy.catalog.js';
import { localizeBillingTotals } from './billing-financial-display.service.js';

/** Called only after the stored financial snapshot and bindings are verified. */
export function localizeBillingCycleDetail<T extends BillingOrganisationFinancialDto<BillingCycleDetailV2>>(
  detail: T, locale?: BillingCustomerLocale,
): T {
  const copy = billingStatementCopy(locale);
  const money = <T extends { amount: string; currency: string; display: string }>(value: T) =>
    localizedBillingMoney(value, billingLocale(locale));
  return {
    ...detail,
    totals: localizeBillingTotals(detail.totals,locale),
    subscription_lines: detail.subscription_lines.map((line) => ({
      ...line, label: line.charge_basis === 'per_seat' ? copy.monthlySeats : copy.monthlySubscription,
      unit_price: money(line.unit_price), customer_charge: money(line.customer_charge),
    })),
    usage_lines: detail.usage_lines.map((line) => ({
      ...line, label: line.usage_payment_mode === 'prepaid' ? copy.prepaidUsage : copy.meteredUsage,
      customer_charge: line.customer_charge ? money(line.customer_charge) : null,
    })),
    documents: detail.documents.map((document) => ({
      ...document, customer_total: document.customer_total ? money(document.customer_total) : null,
    })),
    // Reasons can be authored by an operator and are preserved verbatim.
    adjustments: detail.adjustments.map((item) => ({ ...item,
      customer_amount: money(item.customer_amount) })),
  };
}
