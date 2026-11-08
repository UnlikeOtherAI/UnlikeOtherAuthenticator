import type { PrismaClient } from '@prisma/client';
import type { BillingOrganisationAccruedBillV1 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { assertOrganisationBillPeriod } from './billing-organisation-period.service.js';
import { readOrganisationAccruedUsage } from './billing-organisation-accrual-usage.service.js';
import { readOrganisationAccruedSubscriptions } from './billing-organisation-accrual-subscription.service.js';
import { organisationAccrualTotals } from './billing-organisation-accrual-totals.service.js';
import { organisationFinancialAccount } from './billing-organisation-wallet.service.js';
import type { OrganisationBillingSelection } from './billing-organisation-mode.service.js';
import type { OrganisationBillingContext } from './billing-organisation-authority.service.js';

/** An unbound source is evidence requiring reconciliation, never an implied zero.
 * This reader performs no collection, export, invoice issuance or provider writes. */
export async function readOrganisationAccruedBill(context:OrganisationBillingContext,
  selection:OrganisationBillingSelection,month:string,now:Date,prisma:PrismaClient,
  deps:{usage?:typeof readOrganisationAccruedUsage;subscriptions?:typeof readOrganisationAccruedSubscriptions}={}):Promise<BillingOrganisationAccruedBillV1> {
  const account=await organisationFinancialAccount(selection,prisma);
  const period=await assertOrganisationBillPeriod(prisma,{organisationId:context.request.organisationId,
    accountId:account.id,month,now});
  const [manual,addons,adjustments]=await Promise.all([
    prisma.billingOrganisationContract.count({where:{orgId:context.request.organisationId,
      OR:[{status:'ACTIVE'},{terminatedAt:{gt:period.start}}]}}),
    prisma.billingRecurringAddonSubscription.count({where:{orgId:context.request.organisationId,
      accountId:account.id,createdAt:{lt:period.asOf},OR:[{status:{notIn:['canceled','incomplete_expired']}},
        {currentPeriodEnd:{gt:period.start}}]}}),
    prisma.billingCommercialAdjustment.count({where:{orgId:context.request.organisationId,
      startsAt:{lt:period.asOf},AND:[{OR:[{endsAt:null},{endsAt:{gt:period.start}}]},
        {OR:[{active:true},{deactivatedAt:{gt:period.start}}]}]}}),
  ]);
  if(manual)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_MANUAL_BINDING_RECONCILIATION_REQUIRED');
  if(addons)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_ADDON_RECONCILIATION_REQUIRED');
  if(adjustments)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_ADJUSTMENT_RECONCILIATION_REQUIRED');
  const subscriptions=await (deps.subscriptions??readOrganisationAccruedSubscriptions)({
    organisationId:context.request.organisationId,account,period},prisma);
  const usage=await (deps.usage??readOrganisationAccruedUsage)({organisationId:context.request.organisationId,
    accountId:account.id,period},prisma);
  for(const line of usage.filter(line=>line.kind==='usage')){
    const prepaid=usage.find(offset=>offset.product===line.product&&offset.kind==='prepaid_credit');
    if(line.amountMinor+(prepaid?.amountMinor??0n)>0n &&
      (!line.product||!subscriptions.noTaxProducts.has(line.product))) {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_TAX_RECONCILIATION_REQUIRED');
    }
  }
  const financial=organisationAccrualTotals([...subscriptions.lines,...usage],subscriptions.paid,['USD']);
  return {as_of:period.asOf.toISOString(),period:{month,starts_at:period.start.toISOString(),
    ends_at:period.end.toISOString()},...financial};
}
