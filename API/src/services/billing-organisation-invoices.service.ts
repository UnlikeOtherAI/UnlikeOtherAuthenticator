import { createHash } from 'node:crypto';
import { Prisma,type PrismaClient } from '@prisma/client';
import type { BillingOrganisationFinancialTypes } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import type { BillingCycleContext } from './billing-cycle-read.service.js';
import { authorizeBillingCycle } from './billing-cycle-authority.service.js';
import { localizeCustomerInvoiceDetail,localizeCustomerInvoiceSummary } from './billing-customer-invoice-display.service.js';
import { projectPrepaidCustomerInvoiceDetail,projectPrepaidCustomerInvoiceSummary } from './billing-customer-invoice-prepaid.service.js';
import { projectStripeCustomerInvoiceDetail,projectStripeCustomerInvoiceSummary } from './billing-customer-invoice-stripe.service.js';
import { createBillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import { organisationHistoryAccount,organisationHistorySubject,historyCursorBinding,decodeOrganisationInvoiceCursor,
  encodeOrganisationHistoryCursor,compareOrganisationInvoiceCursor,verifyOrganisationInvoiceServices,
  type OrganisationInvoiceCursor } from './billing-organisation-history.service.js';

type List=BillingOrganisationFinancialTypes['invoices_list_response'];
type Detail=BillingOrganisationFinancialTypes['invoice_detail_response'];
function missing():never{throw new AppError('NOT_FOUND',404,'BILLING_CUSTOMER_INVOICE_NOT_FOUND');}
function monthPeriod(month:string) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new AppError('BAD_REQUEST',400,'BILLING_INVOICE_MONTH_INVALID');
  const start=new Date(`${month}-01T00:00:00.000Z`);return {start,end:new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1))};
}
async function adjustments(db:PrismaClient,rows:Array<{accountId:string;stripePaymentIntentId:string}>) {
  return rows.length?db.billingCreditPaymentAdjustment.findMany({where:{OR:rows.map(row=>({accountId:row.accountId,
    stripePaymentIntentId:row.stripePaymentIntentId}))},orderBy:[{occurredAt:'asc'},{id:'asc'}]}):[];
}
/** Manual sources without a captured mode remain visibly unresolved. They may
 * not appear once under LIVE and again under Sandbox by inference. */
async function assertNoUnboundManualHistory(db:PrismaClient,orgId:string,month?:string) {
  const period=month?monthPeriod(month):null;
  const count=await db.billingInvoice.count({where:{orgId,status:{in:['ISSUED','VOID']},
    ...(period?{OR:[{issuedAt:{gte:period.start,lt:period.end}},
      {paymentEvents:{some:{occurredAt:{gte:period.start,lt:period.end}}}}]}:{})}});
  if(count)throw new AppError('BAD_REQUEST',409,'BILLING_HISTORY_MANUAL_BINDING_RECONCILIATION_REQUIRED');
}
export async function listOrganisationInvoices(context:BillingCycleContext,
  input:{chargeMonth:string;limit?:number;cursor?:string},db:PrismaClient,now=new Date()):Promise<List> {
  await authorizeBillingCycle(context,{prisma:db});const account=await organisationHistoryAccount(context,db);
  const limit=input.limit??20;if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new AppError('BAD_REQUEST',400,'BILLING_INVOICE_LIMIT_INVALID');
  const {start,end}=monthPeriod(input.chargeMonth),binding=historyCursorBinding(context,account.id);
  const cursor=decodeOrganisationInvoiceCursor(input.cursor,binding),at=cursor?new Date(cursor.at):null;
  await assertNoUnboundManualHistory(db,context.request.organisationId,input.chargeMonth);
  const prepaid=await db.billingCreditPaymentInvoice.findMany({where:{orgId:context.request.organisationId,
    accountId:account.id,livemode:account.livemode,paidAt:{gte:start,lt:end},
    ...(at?{AND:[{OR:[{paidAt:{lt:at}},...(cursor?.kind==='prepaid'?[{paidAt:at,id:{lt:cursor.id}}]:[])]}]}:{})},
    include:{creditEntry:true,autoAttempt:{select:{id:true,currency:true}}},orderBy:[{paidAt:'desc'},{id:'desc'}],take:limit+1});
  const stripeKeys=await db.$queryRaw<Array<{id:string;at:Date}>>(Prisma.sql`
    SELECT invoice.id,MAX(cash.paid_at) AS at FROM billing_stripe_payment_invoices invoice
    JOIN billing_stripe_payment_invoice_cash_payments cash ON cash.invoice_id=invoice.id
    WHERE invoice.org_id=${context.request.organisationId} AND invoice.account_id=${account.id}
      AND invoice.livemode=${account.livemode} AND cash.paid_at>=${start} AND cash.paid_at<${end}
    GROUP BY invoice.id ${at?Prisma.sql`HAVING MAX(cash.paid_at)<${at} OR
      (MAX(cash.paid_at)=${at} AND ${cursor?.kind==='stripe'?Prisma.sql`invoice.id<${cursor.id}`:Prisma.sql`TRUE`})`:Prisma.empty}
    ORDER BY MAX(cash.paid_at) DESC,invoice.id DESC LIMIT ${limit+1}`);
  const stripe=await db.billingStripePaymentInvoice.findMany({where:{id:{in:stripeKeys.map(row=>row.id)},
    orgId:context.request.organisationId,accountId:account.id,livemode:account.livemode},
    include:{lines:true,subscription:true,cashPayments:true,adjustments:true}});
  const changes=await adjustments(db,prepaid);
  const services=await db.billingService.findMany({where:{id:{in:[...new Set(prepaid.map(row=>row.serviceId))]}},select:{id:true,identifier:true}});
  const byId=new Map(services.map(service=>[service.id,service.identifier]));
  await Promise.all(stripe.map(row=>verifyOrganisationInvoiceServices(db,row.lines)));
  const rows:Array<{cursor:OrganisationInvoiceCursor;summary:List['invoices'][number]}>= [
    ...prepaid.map(row=>({cursor:{binding,at:row.paidAt.toISOString(),kind:'prepaid' as const,id:row.id},
      summary:projectPrepaidCustomerInvoiceSummary(row,changes.filter(change=>change.accountId===row.accountId&&
        change.stripePaymentIntentId===row.stripePaymentIntentId),byId.get(row.serviceId)??missing(),input.chargeMonth)})),
    ...stripe.map(row=>({cursor:{binding,at:stripeKeys.find(key=>key.id===row.id)?.at.toISOString()??missing(),kind:'stripe' as const,id:row.id},
      summary:projectStripeCustomerInvoiceSummary(row,context.request.product,context.credential.service.id,input.chargeMonth,true)})),
  ];
  const selected=rows.filter(row=>!cursor||compareOrganisationInvoiceCursor(row.cursor,cursor)>0)
    .sort((a,b)=>compareOrganisationInvoiceCursor(a.cursor,b.cursor));
  const page=selected.slice(0,limit),last=page.at(-1);
  await authorizeBillingCycle(context,{prisma:db});
  return {schema_version:1,generated_at:now.toISOString(),subject:organisationHistorySubject(context),charge_month:input.chargeMonth,
    invoices:page.map(row=>localizeCustomerInvoiceSummary(row.summary,context.locale)),
    next_cursor:selected.length>limit&&last?encodeOrganisationHistoryCursor(last.cursor):null};
}

async function read(context:BillingCycleContext,invoiceId:string,db:PrismaClient,chargeMonth?:string) {
  await authorizeBillingCycle(context,{prisma:db});const account=await organisationHistoryAccount(context,db);
  const match=/^(prepaid|stripe):([a-zA-Z0-9_-]{1,128})$/.exec(invoiceId);
  if(!match){if(/^(manual|credit_note):/.test(invoiceId))await assertNoUnboundManualHistory(db,context.request.organisationId);missing();}
  const scope={id:match[2],orgId:context.request.organisationId,accountId:account.id,livemode:account.livemode};
  const subject=organisationHistorySubject(context);
  let detail:Detail,pdfKey:string|null,sha256:string|null;
  if(match[1]==='stripe'){
    const row=await db.billingStripePaymentInvoice.findFirst({where:scope,include:{lines:true,subscription:true,cashPayments:true,adjustments:true}});
    if(!row)missing();await verifyOrganisationInvoiceServices(db,row.lines);
    if(chargeMonth&&!row.cashPayments.some(payment=>payment.paidAt.toISOString().slice(0,7)===chargeMonth))missing();
    detail=projectStripeCustomerInvoiceDetail(row,context.request.product,context.credential.service.id,subject,chargeMonth,true);
    pdfKey=row.pdfObjectKey;sha256=row.pdfSha256;
  }else{
    const row=await db.billingCreditPaymentInvoice.findFirst({where:scope,include:{creditEntry:true,autoAttempt:{select:{id:true,currency:true}}}});
    if(!row)missing();const service=await db.billingService.findUnique({where:{id:row.serviceId},select:{identifier:true}});if(!service)missing();
    detail=projectPrepaidCustomerInvoiceDetail(row,await adjustments(db,[row]),service.identifier,
      {...subject,product:service.identifier,team_id:row.teamId},chargeMonth,context.locale);
    pdfKey=row.pdfObjectKey;sha256=row.pdfSha256;
  }
  if(detail.document)detail={...detail,document:{...detail.document,download_action:{...detail.document.download_action,
    body:{...subject,invoice_id:invoiceId,document_id:invoiceId}}}};
  await authorizeBillingCycle(context,{prisma:db});
  return {detail:localizeCustomerInvoiceDetail(detail,context.locale),pdfKey,sha256};
}
export async function getOrganisationInvoice(context:BillingCycleContext,id:string,db:PrismaClient,chargeMonth?:string) {
  return (await read(context,id,db,chargeMonth)).detail;
}
export async function downloadOrganisationInvoice(context:BillingCycleContext,id:string,documentId:string,db:PrismaClient,
  storage=createBillingInvoicePdfStorage()) {
  if(id!==documentId)missing();const before=await read(context,id,db);
  if(!before.detail.document||!before.pdfKey||!before.sha256)missing();const bytes=await storage.read(before.pdfKey);
  if(bytes.length<5||bytes.length>20*1024*1024||bytes.subarray(0,5).toString('ascii')!=='%PDF-'||
    createHash('sha256').update(bytes).digest('hex')!==before.sha256)throw new AppError('INTERNAL',503,'BILLING_CUSTOMER_INVOICE_DOCUMENT_INTEGRITY');
  const after=await read(context,id,db);
  if(JSON.stringify(before)!==JSON.stringify(after))throw new AppError('INTERNAL',503,'BILLING_CUSTOMER_INVOICE_DOCUMENT_REBOUND');
  return {bytes,contentType:'application/pdf' as const,filename:`invoice-${after.detail.number?.replace(/[^a-zA-Z0-9._-]/g,'_')??'document'}.pdf`};
}
