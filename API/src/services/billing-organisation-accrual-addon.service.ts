import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { stripePaymentInvoiceReadInclude,verifyStripeInvoiceFinancialSource } from './billing-customer-invoice-stripe.service.js';
import type { OrganisationAccrualLine } from './billing-organisation-accrual-totals.service.js';

type Period={month:string;start:Date;end:Date;asOf:Date};
function hold():never {throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_ADDON_RECONCILIATION_REQUIRED');}

/** Licensed monthly add-on fees become due at the captured period start. Actual
 * invoice/cash evidence is required; neither a card nor an active flag proves a
 * fee or payment. Entitlement targets do not filter the organisation's bill. */
export async function readOrganisationAccruedAddons(input:{organisationId:string;account:StripeAccountContext;
  period:Period;observedAt:Date},prisma:PrismaClient) {
  const rows=await prisma.billingRecurringAddonSubscription.findMany({where:{orgId:input.organisationId,
    accountId:input.account.id,createdAt:{lt:input.period.asOf},OR:[{status:{notIn:['canceled','incomplete_expired']}},
      {currentPeriodEnd:{gt:input.period.start}}]},include:{customer:true}});
  const lines:OrganisationAccrualLine[]=[],paid=new Map<string,bigint>(),currencies=new Set<string>();
  for(const row of rows){
    if(row.customer.scope!=='ORGANISATION'||row.customer.teamId!==null||row.customer.orgId!==input.organisationId||
      row.customer.accountId!==input.account.id||row.livemode!==input.account.livemode)
      throw new AppError('INTERNAL',409,'BILLING_LEGACY_TEAM_ADDON_RECONCILIATION_REQUIRED');
    if(row.status==='incomplete_expired'&&!row.entitlementActivatedAt)continue;
    if(!row.currentPeriodStart||!row.currentPeriodEnd||row.currentPeriodEnd<=row.currentPeriodStart)hold();
    const invoices=await prisma.billingStripePaymentInvoice.findMany({where:{orgId:input.organisationId,
      accountId:input.account.id,livemode:input.account.livemode,addonSubscriptionId:row.id,
      addonPeriodStartsAt:{lt:input.period.asOf},addonPeriodEndsAt:{gt:input.period.start}},
      include:stripePaymentInvoiceReadInclude,orderBy:{addonPeriodStartsAt:'asc'}});
    // Refuse gaps and overlapping/double-billed periods. A missing historical
    // invoice needs original-source recovery, never a zero or a cloned balance.
    const activeFrom=row.entitlementActivatedAt??row.createdAt;
    let covered=new Date(Math.max(input.period.start.getTime(),Math.min(activeFrom.getTime(),row.currentPeriodStart.getTime())));
    const end=row.status==='canceled'?new Date(Math.min(input.period.asOf.getTime(),row.currentPeriodEnd.getTime())):input.period.asOf;
    let previousEnd:Date|undefined;
    for(const invoice of invoices){
      const proof=verifyStripeInvoiceFinancialSource(invoice),start=invoice.addonPeriodStartsAt,finish=invoice.addonPeriodEndsAt;
      if(!start||!finish)hold();
      if(invoice.teamId!==null||proof.refunded!==0n||proof.disputed!==0n||start>covered||previousEnd&&start<previousEnd)hold();
      covered=finish;previousEnd=finish;currencies.add(invoice.currency);
      if(start<input.period.start)continue;
      for(const line of invoice.lines){
        if(line.usageMinor!==0n||line.taxMinor!==0n||line.creditMinor!==0n||line.subscriptionMinor!==line.dueMinor)hold();
        lines.push({id:`add_on:${line.id}`,product:line.serviceIdentifier,label:line.label,
          kind:'add_on',currency:invoice.currency,amountMinor:line.dueMinor});
      }
      const accepted=proof.payments.filter(payment=>new Date(payment.at)<=input.observedAt).reduce((sum,item)=>sum+item.amount,0n);
      paid.set(invoice.currency,(paid.get(invoice.currency)??0n)+accepted);
    }
    if(covered<end)hold();
  }
  return {lines,paid,currencies:[...currencies]};
}
