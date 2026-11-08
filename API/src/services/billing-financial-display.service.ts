import type { BillingCycleTotals,BillingOrganisationAccruedBillV1 } from '../contracts/billing-statement-v1.js';
import { billingLocale,type BillingCustomerLocale } from './billing-copy-locale.js';
import { localizedBillingMoney } from './billing-money.service.js';

/** Presentation is rebuilt only from verified source amounts/currencies.
 * This never changes a financial amount, currency, minor unit or stored snapshot. */
export function localizeBillingTotals<T extends BillingCycleTotals>(totals:T[],locale?:BillingCustomerLocale):T[] {
  const money=<M extends {amount:string;currency:string;display:string}>(value:M)=>localizedBillingMoney(value,billingLocale(locale));
  return totals.map(total=>({...total,subscription:money(total.subscription),usage_charge:money(total.usage_charge),tax:money(total.tax),
    gross_total:money(total.gross_total),credits_applied:money(total.credits_applied),total_due:money(total.total_due),
    total_paid:money(total.total_paid),outstanding:money(total.outstanding),
    ...(total.customer_credit_due?{customer_credit_due:money(total.customer_credit_due)}:{})}));
}
export function localizeOrganisationAccruedBill(bill:BillingOrganisationAccruedBillV1,locale?:BillingCustomerLocale):BillingOrganisationAccruedBillV1 {
  return {...bill,totals:localizeBillingTotals(bill.totals,locale),lines:bill.lines.map(line=>({...line,
    amount:localizedBillingMoney(line.amount,billingLocale(locale))}))};
}
