import type { BillingCycleTotals,BillingOrganisationAccruedBillV1 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';

export type OrganisationAccrualLine={id:string;product:string|null;label:string;
  kind:BillingOrganisationAccruedBillV1['lines'][number]['kind'];currency:string;amountMinor:bigint};

/** All addition and currency separation lives in UOA. A prepaid purchase itself
 * is funding, never a second monthly expense; only verified consumption offsets appear. */
export function organisationAccrualTotals(lines:OrganisationAccrualLine[],paidByCurrency:ReadonlyMap<string,bigint>,
  confirmedCurrencies:readonly string[]) {
  const currencies=[...new Set([...confirmedCurrencies,...lines.map(line=>line.currency),...paidByCurrency.keys()])].sort();
  const totals:BillingCycleTotals[]=currencies.map(currency=>{
    const items=lines.filter(line=>line.currency===currency);
    const sum=(kinds:OrganisationAccrualLine['kind'][])=>items.filter(line=>kinds.includes(line.kind))
      .reduce((value,line)=>value+line.amountMinor,0n);
    const subscription=sum(['subscription','add_on']);const usage=sum(['usage']);const tax=sum(['tax']);
    const adjustments=sum(['adjustment']);const applied=-sum(['prepaid_credit']);
    const gross=subscription+usage+tax+adjustments;const due=gross-applied;
    const paid=paidByCurrency.get(currency)??0n;
    if(subscription<0n||usage<0n||tax<0n||applied<0n||gross<0n||due<0n||paid<0n||paid>due) {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_FINANCIAL_RECONCILIATION_REQUIRED');
    }
    const money=(value:bigint)=>cycleMoney(value,currency);
    return {currency,subscription:money(subscription),usage_charge:money(usage),tax:money(tax),gross_total:money(gross),
      credits_applied:money(applied),total_due:money(due),total_paid:money(paid),outstanding:money(due-paid)};
  });
  return {totals,lines:lines.map(line=>({id:line.id,product:line.product,label:line.label,kind:line.kind,
    amount:cycleMoney(line.amountMinor,line.currency)}))};
}
