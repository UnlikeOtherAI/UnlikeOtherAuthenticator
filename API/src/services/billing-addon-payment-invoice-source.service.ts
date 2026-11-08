import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode,type StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { recurringAddonSubscriptionInclude,assertRecurringAddonSubscriptionBinding } from './billing-recurring-addon-subscription.service.js';
import { assertRecurringAddonMetadata } from './billing-recurring-addon-stripe-binding.service.js';
import { assertRecurringAddonInvoiceTerms } from './billing-recurring-addon-webhook.service.js';
import { verifyStripeInvoiceCash,stripeInvoiceMinor,type StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';

type Provider=StripeInvoiceCashClient&Pick<Stripe,'subscriptions'>;
/** Actual provider invoices from a separate captured add-on subscription. This
 * creates neither a base subscription nor any new provider object. */
export async function prepareAddonPaymentInvoice(invoice:Stripe.Invoice,account:StripeAccountContext,db:PrismaClient,stripe:Provider) {
  assertStripeObjectLivemode(invoice,account.livemode);
  const subscriptionId=stripeExternalId(invoice.parent?.subscription_details?.subscription);
  if(!subscriptionId)return null;
  const local=await db.billingRecurringAddonSubscription.findUnique({where:{accountId_stripeSubscriptionId:{accountId:account.id,
    stripeSubscriptionId:subscriptionId}},include:{...recurringAddonSubscriptionInclude,service:true}});
  if(!local)throw new AppError('INTERNAL',409,'BILLING_ADDON_INVOICE_SUBSCRIPTION_PENDING');
  const remote=await stripe.subscriptions.retrieve(subscriptionId);
  assertRecurringAddonSubscriptionBinding(local,remote,account);
  assertRecurringAddonMetadata(invoice.parent?.subscription_details?.metadata,local.checkout,account);
  const stripeCustomerId=local.customer.stripeCustomerId;
  if(!stripeCustomerId||local.customer.orgId!==local.orgId||local.customer.accountId!==account.id||
    stripeExternalId(invoice.customer)!==stripeCustomerId||
    !['subscription_create','subscription_cycle'].includes(invoice.billing_reason??''))
    throw new AppError('INTERNAL',409,'BILLING_ADDON_INVOICE_BINDING_UNPROVEN');
  assertRecurringAddonInvoiceTerms(invoice,local,remote,invoice.billing_reason as 'subscription_create'|'subscription_cycle');
  const line=invoice.lines.data[0];
  if(!line||!Number.isSafeInteger(line.period.start)||!Number.isSafeInteger(line.period.end)||line.period.start<=0||line.period.end<=line.period.start||
    invoice.automatic_tax?.enabled&&invoice.automatic_tax.status!=='complete')
    throw new AppError('INTERNAL',409,'BILLING_ADDON_INVOICE_PERIOD_TAX_UNPROVEN');
  if(invoice.amount_paid===0)return null;
  const cash=await verifyStripeInvoiceCash(invoice,stripe);
  const duplicate=await db.billingCreditPaymentInvoice.findFirst({where:{accountId:account.id,livemode:account.livemode,
    OR:[{stripeInvoiceId:invoice.id},{stripePaymentIntentId:{in:cash.payments.map(row=>row.payment_intent_id)}}]},select:{id:true}});
  if(duplicate)throw new AppError('INTERNAL',409,'STRIPE_SUBSCRIPTION_INVOICE_PREPAID_DUPLICATE');
  const facts={accountId:account.id,subscriptionId:null,addonSubscriptionId:local.id,livemode:account.livemode,
    addonPeriodStartsAt:new Date(line.period.start*1000),addonPeriodEndsAt:new Date(line.period.end*1000),
    stripeInvoiceId:invoice.id,stripeCustomerId,
    stripePaymentIntentIds:cash.payments.map(row=>row.payment_intent_id),paymentEvidence:cash.payments,
    orgId:local.orgId,teamId:local.customer.teamId,paidAt:cash.paidAt,currency:local.catalog.currency,
    grossAmountMinor:stripeInvoiceMinor(invoice.total),taxAmountMinor:0n,creditAmountMinor:0n,
    dueAmountMinor:stripeInvoiceMinor(invoice.amount_due),paidAmountMinor:stripeInvoiceMinor(invoice.amount_paid)};
  const lines=[{stripeLineId:line.id,serviceId:local.serviceId,serviceIdentifier:local.service.identifier,
    billingMonth:new Date(line.period.start*1000).toISOString().slice(0,7),label:local.offer.name,
    subscriptionMinor:stripeInvoiceMinor(line.amount),usageMinor:0n,taxMinor:0n,creditMinor:0n,
    grossMinor:stripeInvoiceMinor(line.amount),dueMinor:stripeInvoiceMinor(line.amount)}];
  const {stripePaymentIntentIds:_intents,paymentEvidence:_payments,paidAt:_paidAt,paidAmountMinor:_paid,...financialFacts}=facts;
  const sourceDigest=createHash('sha256').update(JSON.stringify({facts:financialFacts,lines:lines.map(({label:_label,...value})=>value)},
    (_key,value)=>typeof value==='bigint'?value.toString():value)).digest('hex');
  return {facts,lines,sourceDigest,invoice};
}
