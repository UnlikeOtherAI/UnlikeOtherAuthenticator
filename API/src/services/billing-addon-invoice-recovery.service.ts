import { randomUUID } from 'node:crypto';
import { Prisma,type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { storedStripeBillingReader } from './billing-team-mode.service.js';
import { assertStripeObjectLivemode,resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { prepareStripePaymentInvoice,persistStripePaymentInvoice,type PreparedStripePaymentInvoice }
  from './billing-stripe-payment-invoice-source.service.js';

const PAGE_SIZE=20,LEASE_MS=15*60_000;
type Job={subscriptionId:string;accountId:string;organisationId:string;livemode:boolean;scanBefore:Date;cursor:string|null;attempt:number};
function hold(code:string):never{throw new AppError('INTERNAL',409,code);}
async function historicalCash(prepared:PreparedStripePaymentInvoice,client:Stripe,db:PrismaClient) {
  // An old paid event is not evidence that a refund/dispute never happened.
  // Never invent a webhook ID to manufacture missing adjustment provenance.
  for(const cash of prepared.facts.paymentEvidence){
    const charge=await client.charges.retrieve(cash.charge_id);
    assertStripeObjectLivemode(charge,prepared.facts.livemode);
    if(charge.id!==cash.charge_id||charge.disputed!==false||!Number.isSafeInteger(charge.amount_refunded)||charge.amount_refunded<0)
      hold('BILLING_ADDON_INVOICE_ADJUSTMENT_RECONCILIATION_REQUIRED');
    const known=await db.billingStripePaymentInvoiceAdjustment.aggregate({where:{stripeChargeId:cash.charge_id,kind:'REFUND',
      invoice:{accountId:prepared.facts.accountId,livemode:prepared.facts.livemode,stripeInvoiceId:prepared.facts.stripeInvoiceId}},
      _sum:{amountMinor:true}});
    if((known._sum.amountMinor??0n)!==BigInt(charge.amount_refunded))hold('BILLING_ADDON_INVOICE_ADJUSTMENT_RECONCILIATION_REQUIRED');
  }
}

/** One original subscription and one bounded provider page per call. No provider
 * write, charge, subscription creation or transfer is exposed by this worker. */
export async function runAddonInvoiceRecoveryCycle(deps:{prisma?:PrismaClient;now?:()=>Date;
  scope?:{organisationId:string;accountId:string;livemode:boolean};
  runtime?:typeof storedStripeBillingReader}={}) {
  const db=deps.prisma??getAdminPrisma(),now=(deps.now??(()=>new Date()))(),lease=randomUUID();
  const claimed=await db.$queryRaw<Job[]>(Prisma.sql`
    WITH due AS (SELECT subscription_id FROM billing_addon_invoice_recoveries WHERE NOT complete AND next_attempt_at<=${now}
      AND ${deps.scope?Prisma.sql`org_id=${deps.scope.organisationId} AND account_id=${deps.scope.accountId} AND livemode=${deps.scope.livemode}`:Prisma.sql`TRUE`}
      AND (lease_expires_at IS NULL OR lease_expires_at<=${now}) ORDER BY next_attempt_at,subscription_id
      FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE billing_addon_invoice_recoveries j SET lease_token=${lease}::uuid,lease_expires_at=${new Date(now.getTime()+LEASE_MS)},
      scan_before=COALESCE(j.scan_before,date_trunc('second',${now}::timestamptz)),attempt_count=j.attempt_count+1,updated_at=${now}
    FROM due WHERE j.subscription_id=due.subscription_id RETURNING j.subscription_id AS "subscriptionId",j.account_id AS "accountId",
      j.org_id AS "organisationId",j.livemode,j.scan_before AS "scanBefore",j.cursor,j.attempt_count AS attempt`);
  const job=claimed[0];if(!job)return {checked:0,invoices:0,completed:0,held:0};
  try{
    const source=await db.billingRecurringAddonSubscription.findUniqueOrThrow({where:{id:job.subscriptionId},include:{customer:true}});
    const runtime=await (deps.runtime??storedStripeBillingReader)(job.accountId,db),client=runtime.client;
    const account=await resolveStripeAccountContext(client,runtime.livemode,db);
    if(account.id!==job.accountId||account.livemode!==job.livemode||source.accountId!==account.id||source.orgId!==job.organisationId||
      source.livemode!==job.livemode||source.customer.accountId!==account.id||source.customer.orgId!==source.orgId||!source.customer.stripeCustomerId)
      hold('BILLING_ADDON_INVOICE_RECOVERY_BINDING_INVALID');
    const page=await client.invoices.list({subscription:source.stripeSubscriptionId,limit:PAGE_SIZE,
      created:{lt:Math.floor(job.scanBefore.getTime()/1000)},...(job.cursor?{starting_after:job.cursor}:{})});
    if(page.data.length>PAGE_SIZE||page.has_more&&!page.data.length)hold('BILLING_ADDON_INVOICE_RECOVERY_PAGE_INVALID');
    const prepared:PreparedStripePaymentInvoice[]=[],ids=new Set<string>();
    for(const invoice of page.data){
      assertStripeObjectLivemode(invoice,account.livemode);
      if(!/^in_[a-zA-Z0-9_]+$/.test(invoice.id)||invoice.id===job.cursor||ids.has(invoice.id)||
        !Number.isSafeInteger(invoice.created)||invoice.created>=job.scanBefore.getTime()/1000||
        stripeExternalId(invoice.parent?.subscription_details?.subscription)!==source.stripeSubscriptionId||
        stripeExternalId(invoice.customer)!==source.customer.stripeCustomerId||!Number.isSafeInteger(invoice.amount_paid)||invoice.amount_paid<0)
        hold('BILLING_ADDON_INVOICE_RECOVERY_PAGE_INVALID');
      ids.add(invoice.id);if(invoice.amount_paid===0)continue;
      const value=await prepareStripePaymentInvoice(invoice.id,account,db,client);
      if(!value||!('addonSubscriptionId' in value.facts)||value.facts.addonSubscriptionId!==source.id||
        value.facts.orgId!==job.organisationId||value.facts.accountId!==job.accountId||value.facts.livemode!==job.livemode)
        hold('BILLING_ADDON_INVOICE_RECOVERY_BINDING_INVALID');
      await historicalCash(value,client,db);prepared.push(value);
    }
    const completed=!page.has_more,cursor=page.data.at(-1)?.id??job.cursor,at=(deps.now??(()=>new Date()))();
    await db.$transaction(async tx=>{
      const active=await tx.$queryRaw<Array<{subscription_id:string}>>(Prisma.sql`SELECT subscription_id
        FROM billing_addon_invoice_recoveries WHERE subscription_id=${job.subscriptionId} AND lease_token=${lease}::uuid
        AND lease_expires_at>${at} AND NOT complete FOR UPDATE`);
      if(!active.length)hold('BILLING_ADDON_INVOICE_RECOVERY_LEASE_LOST');
      for(const value of prepared)await persistStripePaymentInvoice(tx,value);
      await tx.$executeRaw(Prisma.sql`UPDATE billing_addon_invoice_recoveries SET cursor=${cursor},complete=${completed},
        completed_at=${completed?at:null},lease_token=NULL,lease_expires_at=NULL,hold_reason=NULL,next_attempt_at=${at},updated_at=${at}
        WHERE subscription_id=${job.subscriptionId} AND lease_token=${lease}::uuid`);
    });
    return {checked:1,invoices:prepared.length,completed:completed?1:0,held:0};
  }catch(error){
    const code=error instanceof AppError&&/^[A-Z][A-Z0-9_]{1,159}$/.test(error.message)?error.message:'BILLING_ADDON_INVOICE_RECOVERY_UNAVAILABLE';
    const at=(deps.now??(()=>new Date()))();
    await db.$executeRaw(Prisma.sql`UPDATE billing_addon_invoice_recoveries SET lease_token=NULL,lease_expires_at=NULL,
      hold_reason=${code},next_attempt_at=${new Date(at.getTime()+Math.min(60,5*2**Math.min(job.attempt-1,4))*60_000)},updated_at=${at}
      WHERE subscription_id=${job.subscriptionId} AND lease_token=${lease}::uuid AND NOT complete`);
    return {checked:1,invoices:0,completed:0,held:1};
  }
}

/** List completeness is independent of a particular confirmed document. Known
 * invoice details/PDFs remain readable while another source is recovering. */
export async function assertAddonInvoiceHistoryComplete(db:PrismaClient,organisationId:string,accountId:string,livemode:boolean) {
  const missing=await db.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT s.id FROM billing_recurring_addon_subscriptions s
    LEFT JOIN billing_addon_invoice_recoveries r ON r.subscription_id=s.id AND r.account_id=s.account_id AND r.org_id=s.org_id AND r.livemode=s.livemode
    WHERE s.org_id=${organisationId} AND s.account_id=${accountId} AND s.livemode=${livemode} AND (r.subscription_id IS NULL OR NOT r.complete) LIMIT 1`);
  if(missing.length)hold('BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED');
}
