import type { BillingCycleDetailV2 } from '../contracts/billing-statement-v1.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { localizedBillingMoney } from './billing-money.service.js';
import { billingStatementCopy } from './billing-statement-copy.catalog.js';

/** Called only after the stored financial snapshot and bindings are verified. */
export function localizeBillingCycleDetail(
  detail: BillingCycleDetailV2, locale?: BillingCustomerLocale,
): BillingCycleDetailV2 {
  if (!locale) return detail;
  const copy = billingStatementCopy(locale);
  const money = <T extends { amount: string; currency: string; display: string }>(value: T) =>
    localizedBillingMoney(value, locale);
  return {
    ...detail,
    totals: detail.totals.map((total) => ({
      ...total, subscription: money(total.subscription), usage_charge: money(total.usage_charge),
      tax: money(total.tax), gross_total: money(total.gross_total),
      credits_applied: money(total.credits_applied), total_due: money(total.total_due),
      total_paid: money(total.total_paid), outstanding: money(total.outstanding),
      ...(total.customer_credit_due ? { customer_credit_due: money(total.customer_credit_due) } : {}),
    })),
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
