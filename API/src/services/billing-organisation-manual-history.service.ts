import { Prisma,type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { BillingCycleContext } from './billing-cycle-read.service.js';
import { projectManualCustomerInvoiceDetail,projectManualCustomerInvoiceSummary } from './billing-customer-invoice-manual.service.js';
import { projectCustomerCreditNoteDetail,projectCustomerCreditNoteSummary } from './billing-customer-invoice-credit-note.service.js';
import { organisationHistorySubject,organisationInvoiceAfterSql,verifyOrganisationInvoiceServices,
  type OrganisationInvoiceCursor } from './billing-organisation-history.service.js';

const include={lines:true,paymentEvents:true,manualCreditNotes:true,contractVersion:true} as const;
function missing():never{throw new AppError('NOT_FOUND',404,'BILLING_CUSTOMER_INVOICE_NOT_FOUND');}
/** Unbound historical contracts cannot acquire a mode by being displayed. */
export async function assertNoUnboundManualHistory(db:PrismaClient,orgId:string,period:{start:Date;end:Date}) {
  const [invoices,notes]=await Promise.all([
    db.billingInvoice.count({where:{orgId,status:{in:['ISSUED','VOID']},contract:{billingAccountId:null},
      OR:[{issuedAt:{gte:period.start,lt:period.end}},
        {paymentEvents:{some:{kind:'PAYMENT',occurredAt:{gte:period.start,lt:period.end}}}}]}}),
    db.billingManualCreditNote.count({where:{orgId,status:'ISSUED',issuedAt:{gte:period.start,lt:period.end},
      originalInvoice:{contract:{billingAccountId:null}}}}),
  ]);
  if(invoices||notes)throw new AppError('BAD_REQUEST',409,'BILLING_HISTORY_MANUAL_BINDING_RECONCILIATION_REQUIRED');
}
export async function listOrganisationManualInvoices(context:BillingCycleContext,accountId:string,
  input:{month:string;start:Date;end:Date;binding:string;cursor:OrganisationInvoiceCursor|null;limit:number},db:PrismaClient) {
  const keys=await db.$queryRaw<Array<{id:string;at:Date;kind:'manual'|'credit_note'}>>(Prisma.sql`
    WITH manual AS (
      SELECT i.id,GREATEST(CASE WHEN i.issued_at>=${input.start} AND i.issued_at<${input.end} THEN i.issued_at END,
        MAX(p.occurred_at)) AS at FROM billing_invoices i
      JOIN billing_organisation_contracts c ON c.id=i.contract_id AND c.org_id=i.org_id
      LEFT JOIN billing_invoice_payment_events p ON p.invoice_id=i.id AND p.kind='PAYMENT'
        AND p.occurred_at>=${input.start} AND p.occurred_at<${input.end}
      WHERE i.org_id=${context.request.organisationId} AND c.billing_account_id=${accountId} AND i.status IN ('ISSUED','VOID')
      GROUP BY i.id
    ), combined AS (
      SELECT id,at,'manual'::text AS kind FROM manual WHERE at IS NOT NULL AND
        ${organisationInvoiceAfterSql(input.cursor,'manual',Prisma.sql`at`,Prisma.sql`id`)}
      UNION ALL SELECT n.id,n.issued_at,'credit_note'::text FROM billing_manual_credit_notes n
      JOIN billing_invoices i ON i.id=n.original_invoice_id AND i.org_id=n.org_id
      JOIN billing_organisation_contracts c ON c.id=i.contract_id AND c.org_id=i.org_id
      WHERE n.org_id=${context.request.organisationId} AND c.billing_account_id=${accountId}
        AND n.status='ISSUED' AND n.issued_at>=${input.start} AND n.issued_at<${input.end}
        AND ${organisationInvoiceAfterSql(input.cursor,'credit_note',Prisma.sql`n.issued_at`,Prisma.sql`n.id`)}
    ) SELECT * FROM combined ORDER BY at DESC,kind COLLATE "C",id COLLATE "C" DESC LIMIT ${input.limit+1}`);
  return Promise.all(keys.map(async key=>{
    const source=await readOrganisationManualInvoice(context,accountId,`${key.kind}:${key.id}`,db,input.month);
    return {cursor:{binding:input.binding,at:key.at.toISOString(),kind:key.kind,id:key.id},summary:source.summary};
  }));
}
export async function readOrganisationManualInvoice(context:BillingCycleContext,accountId:string,
  invoiceId:string,db:PrismaClient,month?:string) {
  const match=/^(manual|credit_note):([a-zA-Z0-9_-]{1,128})$/.exec(invoiceId);if(!match)missing();
  const subject=organisationHistorySubject(context),orgId=context.request.organisationId;
  if(match[1]==='manual'){
    const row=await db.billingInvoice.findFirst({where:{id:match[2],orgId,contract:{orgId,billingAccountId:accountId}},include});
    if(!row)missing();if(row.contractVersion.contractId!==row.contractId)missing();
    await verifyOrganisationInvoiceServices(db,row.lines);
    // Validate the same legal/cash evidence for list, detail and document reads.
    const summary=projectManualCustomerInvoiceSummary(row,month);
    return {summary,detail:projectManualCustomerInvoiceDetail(row,subject,month,true),pdfKey:row.pdfObjectKey,sha256:row.pdfSha256};
  }
  const row=await db.billingManualCreditNote.findFirst({where:{id:match[2],orgId,
    originalInvoice:{orgId,contract:{orgId,billingAccountId:accountId}}},
    include:{originalInvoice:{include:{lines:true,paymentEvents:true,contractVersion:true}}}});
  if(!row)missing();if(row.originalInvoice.contractVersion.contractId!==row.originalInvoice.contractId)missing();
  await verifyOrganisationInvoiceServices(db,row.originalInvoice.lines);
  const summary=projectCustomerCreditNoteSummary(row,month??row.issuedAt?.toISOString().slice(0,7)??missing());
  return {summary,detail:projectCustomerCreditNoteDetail(row,subject,month,context.locale,true),pdfKey:row.pdfObjectKey,sha256:row.pdfSha256};
}
