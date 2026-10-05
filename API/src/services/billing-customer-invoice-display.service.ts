import type {
  BillingCustomerInvoiceDetailV1, BillingCustomerInvoiceSummaryV1,
} from '../contracts/billing-statement-v1.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { localizedBillingMoney } from './billing-money.service.js';

export function localizeCustomerInvoiceSummary<T extends BillingCustomerInvoiceSummaryV1>(
  summary: T, locale?: BillingCustomerLocale,
): T {
  if (!locale) return summary;
  const money = <M extends { amount: string; currency: string; display: string }>(value: M) =>
    localizedBillingMoney(value, locale);
  const total = summary.totals;
  return { ...summary, payments_in_charge_month: money(summary.payments_in_charge_month),
    totals: { ...total, gross_total: money(total.gross_total),
      tax: total.tax ? money(total.tax) : null, credits_applied: money(total.credits_applied),
      voided_amount: money(total.voided_amount), total_due: money(total.total_due),
      total_paid: money(total.total_paid), refunded_amount: money(total.refunded_amount),
      disputed_amount: money(total.disputed_amount), write_off: money(total.write_off),
      outstanding: money(total.outstanding),
      ...(total.customer_credit_due ? { customer_credit_due: money(total.customer_credit_due) } : {}),
    } };
}

export function localizeCustomerInvoiceDetail(
  detail: BillingCustomerInvoiceDetailV1, locale?: BillingCustomerLocale,
): BillingCustomerInvoiceDetailV1 {
  if (!locale) return detail;
  return { ...localizeCustomerInvoiceSummary(detail, locale),
    payments: detail.payments.map((payment) => ({ ...payment,
      amount: localizedBillingMoney(payment.amount, locale) })),
    charges: detail.charges.map((charge) => ({ ...charge,
      amount: localizedBillingMoney(charge.amount, locale) })),
  };
}
