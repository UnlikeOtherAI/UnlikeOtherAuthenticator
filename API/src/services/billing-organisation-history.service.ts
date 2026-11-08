import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { resolveOrganisationBillingMode } from './billing-organisation-mode.service.js';
import type { BillingCycleContext } from './billing-cycle-read.service.js';

export type OrganisationHistorySelection={financialScope?:'organisation';billingMode?:'live'|'sandbox'};
export async function organisationHistoryAccount(context:BillingCycleContext,prisma:PrismaClient) {
  const mode=context.billingMode??(await resolveOrganisationBillingMode(context.request.organisationId,prisma)).mode;
  const env=getEnv();const stripeAccountId=mode==='live'?env.STRIPE_LIVE_ACCOUNT_ID:env.STRIPE_SANDBOX_ACCOUNT_ID;
  if(!stripeAccountId)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const account=await prisma.billingStripeAccount.findUnique({where:{stripeAccountId_livemode:{stripeAccountId,livemode:mode==='live'}}});
  if(!account)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_HISTORY_ACCOUNT_NOT_PROVISIONED');
  return {...account,mode};
}
export function organisationHistorySubject(context:BillingCycleContext) {
  return {product:context.request.product,organisation_id:context.request.organisationId,team_id:context.request.teamId,
    user_id:context.request.userId,financial_scope:'organisation' as const,
    ...(context.billingMode?{billing_mode:context.billingMode}:{})};
}
export function historyCursorBinding(context:BillingCycleContext,accountId:string) {
  return createHash('sha256').update(JSON.stringify(['organisation-history-v1',context.request.organisationId,accountId])).digest('hex');
}
const cursorSchema=z.object({binding:z.string().regex(/^[0-9a-f]{64}$/),at:z.iso.datetime(),
  kind:z.enum(['prepaid','stripe']),id:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)}).strict();
export type OrganisationInvoiceCursor=z.infer<typeof cursorSchema>;
export function decodeOrganisationInvoiceCursor(value:string|undefined,binding:string):OrganisationInvoiceCursor|null {
  if(!value)return null;
  try{
    if(value.length>2048)throw Error();const parsed=cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));
    if(parsed.binding!==binding||Buffer.from(JSON.stringify(parsed)).toString('base64url')!==value)throw Error();return parsed;
  }catch{throw new AppError('BAD_REQUEST',400,'BILLING_INVOICE_CURSOR_INVALID');}
}
export const encodeOrganisationHistoryCursor=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function compareOrganisationInvoiceCursor(a:OrganisationInvoiceCursor,b:OrganisationInvoiceCursor) {
  return Buffer.compare(Buffer.from(b.at),Buffer.from(a.at))||Buffer.compare(Buffer.from(a.kind),Buffer.from(b.kind))||
    Buffer.compare(Buffer.from(b.id),Buffer.from(a.id));
}
/** Source labels must resolve to current UOA service IDs. The product presenting
 * the manager's actor is an admission audience, never a financial row filter. */
export async function verifyOrganisationInvoiceServices(prisma:PrismaClient,
  lines:Array<{serviceId:string;serviceIdentifier:string}>) {
  const ids=[...new Set(lines.map(line=>line.serviceId))];
  const services=await prisma.billingService.findMany({where:{id:{in:ids}},select:{id:true,identifier:true}});
  const byId=new Map(services.map(service=>[service.id,service.identifier]));
  if(!lines.length||lines.some(line=>byId.get(line.serviceId)!==line.serviceIdentifier)) {
    throw new AppError('INTERNAL',503,'BILLING_HISTORY_SERVICE_BINDING_UNPROVEN');
  }
}
