import { createHash } from 'node:crypto';
import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { BillingOrganisationFinancialTypes } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { authorizeBillingCycle } from './billing-cycle-authority.service.js';
import { hydrateBillingCycle,billingCycleSummary,type BillingCycleContext } from './billing-cycle-read.service.js';
import { createBillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import { organisationHistoryAccount,organisationHistorySubject,historyCursorBinding,encodeOrganisationHistoryCursor } from './billing-organisation-history.service.js';

const cursorSchema=z.object({binding:z.string().regex(/^[0-9a-f]{64}$/),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  serviceId:z.string().min(1).max(256),teamId:z.string().max(256)}).strict();
function cursor(value:string|undefined,binding:string) {
  if(!value)return null;try{if(value.length>2048)throw Error();
    const result=cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));
    if(result.binding!==binding||encodeOrganisationHistoryCursor(result)!==value)throw Error();return result;
  }catch{throw new AppError('BAD_REQUEST',400,'BILLING_CYCLE_CURSOR_INVALID');}
}
/** Join only immutable captured sources. A source must agree with the cycle's
 * actual org/service/team; a wallet and subscription cannot name different money. */
function sources(orgId:string,cycleId?:string) {
  return Prisma.sql`WITH latest AS (
    SELECT DISTINCT ON (c.billing_month,c.service_id,COALESCE(c.team_id,'')) c.*
    FROM billing_customer_cycles c WHERE c.org_id=${orgId} ${cycleId?Prisma.sql`AND c.id=${cycleId}`:Prisma.empty}
    ORDER BY c.billing_month DESC,c.service_id,COALESCE(c.team_id,''),c.revision DESC,c.id DESC
  ), bound AS (
    SELECT c.id,c.billing_month,c.service_id,COALESCE(c.team_id,'') AS team_key,
      COALESCE(s.account_id,contract.billing_account_id,w.account_id) AS account_id,
      (s.account_id IS NOT NULL AND w.account_id IS NOT NULL AND s.account_id<>w.account_id OR
       contract.billing_account_id IS NOT NULL AND w.account_id IS NOT NULL AND contract.billing_account_id<>w.account_id) AS conflict
    FROM latest c LEFT JOIN billing_stripe_subscriptions s
      ON c.private_evidence#>>'{quote,source,kind}'='stripe'
      AND s.id=c.private_evidence#>>'{quote,source,id}' AND s.org_id=c.org_id AND s.service_id=c.service_id
      AND s.team_id IS NOT DISTINCT FROM c.team_id
    LEFT JOIN billing_contract_service_terms term ON c.private_evidence#>>'{quote,source,kind}'='manual'
      AND term.id=c.private_evidence#>>'{quote,source,id}' AND term.service_id=c.service_id AND c.team_id IS NULL
    LEFT JOIN billing_organisation_contract_versions version ON version.id=term.contract_version_id
    LEFT JOIN billing_organisation_contracts contract ON contract.id=version.contract_id AND contract.org_id=c.org_id
    LEFT JOIN billing_credit_accounts w ON w.id=c.private_evidence#>>'{wallet_boundary,account_id}'
      AND w.org_id=c.org_id AND (w.team_id IS NOT DISTINCT FROM c.team_id OR c.payer_scope='ORGANISATION' AND w.team_id IS NULL)
  )`;
}
async function assertBound(db:PrismaClient,orgId:string,cycleId?:string) {
  const rows=await db.$queryRaw<Array<{count:bigint}>>(Prisma.sql`${sources(orgId,cycleId)}
    SELECT count(*) FROM bound WHERE account_id IS NULL OR conflict`);
  if(rows[0]?.count)throw new AppError('BAD_REQUEST',409,'BILLING_CYCLE_ACCOUNT_BINDING_RECONCILIATION_REQUIRED');
}
export async function listOrganisationCycles(context:BillingCycleContext,input:{limit?:number;cursor?:string},db:PrismaClient,
  now=new Date()):Promise<BillingOrganisationFinancialTypes['cycles_list_response']> {
  await authorizeBillingCycle(context,{prisma:db});const account=await organisationHistoryAccount(context,db);
  const limit=input.limit??12;if(!Number.isSafeInteger(limit)||limit<1||limit>24)throw new AppError('BAD_REQUEST',400,'BILLING_CYCLE_LIMIT_INVALID');
  const binding=historyCursorBinding(context,account.id),after=cursor(input.cursor,binding);
  await assertBound(db,context.request.organisationId);
  const keys=await db.$queryRaw<Array<{id:string}>>(Prisma.sql`${sources(context.request.organisationId)}
    SELECT id FROM bound WHERE account_id=${account.id} AND NOT conflict
      ${after?Prisma.sql`AND (billing_month<${after.month} OR billing_month=${after.month} AND
        (service_id COLLATE "C">${after.serviceId} COLLATE "C" OR service_id=${after.serviceId} AND team_key COLLATE "C">${after.teamId} COLLATE "C"))`:Prisma.empty}
    ORDER BY billing_month DESC,service_id COLLATE "C",team_key COLLATE "C" LIMIT ${limit+1}`);
  const rows=await db.billingCustomerCycle.findMany({where:{id:{in:keys.slice(0,limit).map(row=>row.id)},orgId:context.request.organisationId},
    include:{documents:true,service:{select:{id:true,identifier:true}}}});
  const byId=new Map(rows.map(row=>[row.id,row]));const selected=keys.slice(0,limit).map(key=>byId.get(key.id)??missing());
  const cycles=selected.map(row=>billingCycleSummary(hydrateBillingCycle(row,context,row.service)));
  const last=selected.at(-1);await authorizeBillingCycle(context,{prisma:db});
  return {schema_version:2,generated_at:now.toISOString(),subject:organisationHistorySubject(context),cycles,
    next_cursor:keys.length>limit&&last?encodeOrganisationHistoryCursor({binding,month:last.billingMonth,serviceId:last.serviceId,teamId:last.teamId??''}):null};
}
function missing():never{throw new AppError('NOT_FOUND',404,'BILLING_CYCLE_NOT_FOUND');}
export async function readOrganisationCycle(context:BillingCycleContext,id:string,db:PrismaClient) {
  await authorizeBillingCycle(context,{prisma:db});const account=await organisationHistoryAccount(context,db);
  await assertBound(db,context.request.organisationId,id);
  const keys=await db.$queryRaw<Array<{id:string}>>(Prisma.sql`${sources(context.request.organisationId,id)}
    SELECT id FROM bound WHERE account_id=${account.id} AND NOT conflict`);
  if(keys.length!==1)missing();const row=await db.billingCustomerCycle.findFirst({where:{id,orgId:context.request.organisationId},
    include:{documents:true,service:{select:{id:true,identifier:true}}}});if(!row)missing();
  const detail=hydrateBillingCycle(row,context,row.service);await authorizeBillingCycle(context,{prisma:db});return {detail,row};
}
export async function downloadOrganisationCycle(context:BillingCycleContext,id:string,documentId:string,db:PrismaClient,
  storage=createBillingInvoicePdfStorage()) {
  const before=await readOrganisationCycle(context,id,db);const document=before.row.documents.find(row=>row.id===documentId);if(!document)missing();
  const bytes=await storage.read(document.objectKey);
  if(!bytes.length||bytes.length>20*1024*1024||
    (document.format==='pdf'&&bytes.subarray(0,5).toString()!=='%PDF-')||
    (document.format==='csv'&&bytes.subarray(0,3).toString('hex')!=='efbbbf')||
    createHash('sha256').update(bytes).digest('hex')!==document.sha256)throw new AppError('INTERNAL',503,'BILLING_CYCLE_DOCUMENT_INTEGRITY');
  const after=await readOrganisationCycle(context,id,db);
  if(after.row.snapshotSha256!==before.row.snapshotSha256)throw new AppError('INTERNAL',503,'BILLING_CYCLE_DOCUMENT_REBOUND');
  return {bytes,contentType:document.format==='pdf'?'application/pdf' as const:'text/csv' as const,
    filename:`billing-${before.row.billingMonth}-${document.kind}.${document.format}`};
}
