import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';
import { storedStripeBillingReader } from './billing-team-mode.service.js';
import { assertStripeObjectLivemode,type StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { verifyStripeInvoiceFinancialSource } from './billing-customer-invoice-stripe.service.js';
import type { OrganisationAccrualLine } from './billing-organisation-accrual-totals.service.js';

type Period={month:string;start:Date;end:Date;asOf:Date};
export async function readOrganisationAccruedSubscriptions(input:{organisationId:string;account:StripeAccountContext;period:Period;observedAt?:Date},
  prisma:PrismaClient,deps:{quote?:typeof quoteSubscriptionMonthlyCharge;runtime?:typeof storedStripeBillingReader}={}) {
  const rows=await prisma.billingStripeSubscription.findMany({where:{orgId:input.organisationId,
    accountId:input.account.id,OR:[{status:{notIn:['canceled','incomplete_expired']}},
      {billableUntil:{gt:input.period.start}}]},include:{customer:true,service:true}});
  const lines:OrganisationAccrualLine[]=[];const noTaxProducts=new Set<string>();
  for(const row of rows){
    if(row.scope!=='ORGANISATION'||row.teamId!==null||row.customer.scope!=='ORGANISATION'||row.customer.teamId!==null) {
      throw new AppError('INTERNAL',409,'BILLING_LEGACY_TEAM_SUBSCRIPTION_RECONCILIATION_REQUIRED');
    }
    const runtime=await (deps.runtime??storedStripeBillingReader)(row.accountId,prisma);
    const remote=await runtime.client.subscriptions.retrieve(row.stripeSubscriptionId);
    assertStripeObjectLivemode(remote,input.account.livemode);
    if(remote.id!==row.stripeSubscriptionId||!row.customer.stripeCustomerId||
      stripeExternalId(remote.customer)!==row.customer.stripeCustomerId||row.customer.accountId!==row.accountId||
      row.customer.orgId!==row.orgId||remote.metadata.uoa_scope_key!==row.scopeKey||
      remote.metadata.uoa_stripe_account_id!==input.account.stripeAccountId||
      remote.metadata.uoa_stripe_mode!==(input.account.livemode?'live':'test')) {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_SUBSCRIPTION_BINDING_UNPROVEN');
    }
    if(remote.automatic_tax?.enabled!==false||!Array.isArray(remote.default_tax_rates)||remote.default_tax_rates.length!==0) {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_TAX_RECONCILIATION_REQUIRED');
    }
    noTaxProducts.add(row.service.identifier);
    if(row.billableFrom && row.billableFrom>=input.period.asOf)continue;
    // The checkout's explicit free calendar-alignment period is not an earned fee.
    if(remote.status==='trialing'&&remote.trial_end!==null&&remote.trial_end*1000===input.period.end.getTime())continue;
    const quote=await (deps.quote??quoteSubscriptionMonthlyCharge)({source:{kind:'stripe',id:row.id},
      billingMonth:input.period.month,...(input.period.asOf<input.period.end?{asOf:input.period.asOf}:{})},{prisma});
    if(quote.organisationId!==input.organisationId||quote.teamId!==null||quote.scope!=='ORGANISATION') {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_SUBSCRIPTION_BINDING_UNPROVEN');
    }
    lines.push({id:`subscription:${row.id}`,product:row.service.identifier,label:row.service.name,
      kind:'subscription',currency:quote.currency,amountMinor:quote.amountMinor});
  }
  const invoices=await prisma.billingStripePaymentInvoice.findMany({where:{orgId:input.organisationId,
    accountId:input.account.id,livemode:input.account.livemode,subscriptionId:{not:null},lines:{some:{billingMonth:input.period.month}}},
    include:{lines:true,subscription:true,cashPayments:true,adjustments:true}});
  const paid=new Map<string,bigint>();
  for(const row of invoices){
    const proof=verifyStripeInvoiceFinancialSource(row);
    if(row.lines.some(line=>line.billingMonth!==input.period.month)||proof.refunded!==0n||proof.disputed!==0n) {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_PAYMENT_RECONCILIATION_REQUIRED');
    }
    const accepted=proof.payments.filter(payment=>new Date(payment.at)<=(input.observedAt??input.period.asOf))
      .reduce((sum,payment)=>sum+payment.amount,0n);
    paid.set(row.currency,(paid.get(row.currency)??0n)+accepted);
  }
  return {lines,paid,noTaxProducts};
}
