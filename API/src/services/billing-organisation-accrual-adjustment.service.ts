import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { OrganisationAccrualLine } from './billing-organisation-accrual-totals.service.js';

/** Org rows and team-targeted commercial rows each contribute exactly once.
 * The selected team never filters the payer's liabilities. */
export async function readOrganisationAccruedAdjustments(input:{organisationId:string;accountId:string;
  period:{start:Date;asOf:Date};noTaxProducts:ReadonlySet<string>},db:PrismaClient):Promise<OrganisationAccrualLine[]> {
  const rows=await db.billingCommercialAdjustment.findMany({where:{orgId:input.organisationId,startsAt:{lt:input.period.asOf},
    AND:[{OR:[{endsAt:null},{endsAt:{gt:input.period.start}}]},
      {OR:[{active:true},{deactivatedAt:{gt:input.period.start}}]},
      {OR:[{cadence:'MONTHLY'},{cadence:'ONE_TIME',startsAt:{gte:input.period.start}}]}]},
    include:{service:true},orderBy:[{serviceId:'asc'},{id:'asc'}]});
  if(rows.some(row=>!row.billingAccountId))throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_ADJUSTMENT_BINDING_RECONCILIATION_REQUIRED');
  return rows.filter(row=>row.billingAccountId===input.accountId&&row.amountMinor!==0n&&
    (row.active||Boolean(row.deactivatedAt&&row.deactivatedAt>row.startsAt))).map(row=>{
    if(!input.noTaxProducts.has(row.service.identifier))throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_ADJUSTMENT_TAX_RECONCILIATION_REQUIRED');
    return {id:`adjustment:${row.id}`,product:row.service.identifier,label:row.name,kind:'adjustment',
      currency:row.currency,amountMinor:row.kind==='CREDIT'?-row.amountMinor:row.amountMinor};
  });
}
