import type { PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale,BillingOrganisationCapabilitiesV1,BillingOrganisationOverviewV1,
  BillingOrganisationSectionV1,BillingOrganisationHistoryV1 } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { authorizeOrganisationBilling,type OrganisationBillingContext } from './billing-organisation-authority.service.js';
import { resolveOrganisationBillingMode,type OrganisationBillingSelection } from './billing-organisation-mode.service.js';
import { billingOrganisationCopy } from './billing-organisation-copy.catalog.js';
import { readOrganisationCreditBalance,readOrganisationFunding } from './billing-organisation-wallet.service.js';
import { readOrganisationSubscription } from './billing-organisation-subscription.service.js';
import { readOrganisationAccruedBill } from './billing-organisation-accrual.service.js';
import { organisationBillingPeriod } from './billing-organisation-period.service.js';
import { readOrganisationAttention } from './billing-organisation-attention.service.js';

function subject(context:OrganisationBillingContext) {
  return {product:context.request.product,organisation_id:context.request.organisationId,
    team_id:context.request.teamId,user_id:context.request.userId};
}
function scope(context:OrganisationBillingContext,selection:OrganisationBillingSelection) {
  return {kind:'organisation' as const,organisation_id:context.request.organisationId,...selection};
}
export async function organisationBillingCapabilities(context:OrganisationBillingContext,
  deps:{prisma?:PrismaClient;now?:Date}={}):Promise<BillingOrganisationCapabilitiesV1> {
  const prisma=deps.prisma??getAdminPrisma();
  const viewer=await authorizeOrganisationBilling(context,prisma);
  const base={schema_version:1 as const,generated_at:(deps.now??new Date()).toISOString(),subject:subject(context)};
  if(!viewer.billingManager)return {...base,capabilities:{can_view_billing:false,can_manage_billing:false}};
  return {...base,capabilities:{can_view_billing:true,can_manage_billing:true},
    financial_scope:scope(context,await resolveOrganisationBillingMode(context.request.organisationId,prisma))};
}

async function section<T>(read:()=>Promise<T>,locale?:BillingCustomerLocale):Promise<BillingOrganisationSectionV1<T>> {
  const copy=billingOrganisationCopy(locale);
  try{return {state:'confirmed',message:copy.confirmed,data:await read()};}
  catch(error){
    // Authority failures invalidate the whole response; they are never hidden as a dependency outage.
    if(error instanceof AppError && (error.statusCode===401||error.statusCode===403))throw error;
    const code=error instanceof AppError?error.message:'BILLING_SECTION_UNAVAILABLE';
    const pending=error instanceof AppError && error.statusCode===409;
    return {state:pending?'pending_reconciliation':'unavailable',code,
      message:code==='BILLING_REGION_REQUIRED'?copy.regionRequired:pending?copy.pending:copy.unavailable};
  }
}

export async function organisationBillingOverview(context:OrganisationBillingContext,
  input:{month?:string;locale?:BillingCustomerLocale}={},deps:{prisma?:PrismaClient;now?:Date;
    balance?:typeof readOrganisationCreditBalance;funding?:typeof readOrganisationFunding;
    subscription?:typeof readOrganisationSubscription;bill?:typeof readOrganisationAccruedBill;
    attention?:typeof readOrganisationAttention}={}):Promise<BillingOrganisationOverviewV1> {
  const prisma=deps.prisma??getAdminPrisma();const now=deps.now??new Date();
  const viewer=await authorizeOrganisationBilling(context,prisma);
  if(!viewer.billingManager)throw new AppError('FORBIDDEN',403,'BILLING_MANAGER_REQUIRED');
  const selection=await resolveOrganisationBillingMode(context.request.organisationId,prisma);
  const month=input.month??now.toISOString().slice(0,7);organisationBillingPeriod(month,now);
  const history=async ():Promise<BillingOrganisationHistoryV1>=>{
    const captured_sources=(['live','sandbox'] as const).map(mode=>{
      const body={...subject(context),financial_scope:'organisation' as const,billing_mode:mode};
      return {mode,cycles_request:{method:'POST' as const,path:'/billing/v1/cycles/list' as const,body},
        invoices_request:{method:'POST' as const,path:'/billing/v1/invoices/list' as const,body:{...body,charge_month:month}}};
    });
    const current=captured_sources.find(source=>source.mode===selection.mode);
    if(!current)throw new AppError('INTERNAL',503,'BILLING_HISTORY_MODE_UNAVAILABLE');
    return {cycles_request:current.cycles_request,invoices_request:current.invoices_request,captured_sources};
  };
  const [accrued_bill,credits,funding,subscription,historySection,attention]=await Promise.all([
    section(()=> (deps.bill??readOrganisationAccruedBill)(context,selection,month,now,prisma),input.locale),
    section(()=> (deps.balance??readOrganisationCreditBalance)(context,selection,prisma,input.locale),input.locale),
    section(()=> (deps.funding??readOrganisationFunding)(context,selection,prisma,input.locale,now),input.locale),
    section(()=> (deps.subscription??readOrganisationSubscription)(context,prisma,input.locale,now),input.locale),
    section(history,input.locale),
    section(()=>(deps.attention??readOrganisationAttention)(context,selection,prisma,now),input.locale),
  ]);
  // Dependencies can take seconds. Recheck authority and policy before publishing actions or money.
  const finalViewer=await authorizeOrganisationBilling(context,prisma);
  if(!finalViewer.billingManager)throw new AppError('FORBIDDEN',403,'BILLING_MANAGER_REQUIRED');
  const current=await resolveOrganisationBillingMode(context.request.organisationId,prisma);
  if(JSON.stringify(current)!==JSON.stringify(selection))throw new AppError('BAD_REQUEST',409,'BILLING_CONTEXT_STALE');
  return {schema_version:1,generated_at:now.toISOString(),subject:subject(context),financial_scope:scope(context,selection),
    sections:{accrued_bill,credits,funding,subscription,history:historySection,attention}};
}
