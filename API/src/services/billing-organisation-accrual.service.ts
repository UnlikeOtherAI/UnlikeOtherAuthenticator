import type { PrismaClient } from '@prisma/client';
import type { BillingOrganisationAccruedBillV1 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { assertOrganisationBillPeriod } from './billing-organisation-period.service.js';
import { readOrganisationAccruedUsage } from './billing-organisation-accrual-usage.service.js';
import { readOrganisationAccruedSubscriptions } from './billing-organisation-accrual-subscription.service.js';
import { readOrganisationAccruedManual } from './billing-organisation-accrual-manual.service.js';
import { readOrganisationAccruedAddons } from './billing-organisation-accrual-addon.service.js';
import { readOrganisationAccruedAdjustments } from './billing-organisation-accrual-adjustment.service.js';
import { organisationAccrualTotals } from './billing-organisation-accrual-totals.service.js';
import { organisationFinancialAccount } from './billing-organisation-wallet.service.js';
import type { OrganisationBillingSelection } from './billing-organisation-mode.service.js';
import type { OrganisationBillingContext } from './billing-organisation-authority.service.js';

/** An unbound source is evidence requiring reconciliation, never an implied zero.
 * This reader performs no collection, export, invoice issuance or provider writes. */
export async function readOrganisationAccruedBill(context:OrganisationBillingContext,
  selection:OrganisationBillingSelection,month:string,now:Date,prisma:PrismaClient,
  deps:{usage?:typeof readOrganisationAccruedUsage;subscriptions?:typeof readOrganisationAccruedSubscriptions;
    manual?:typeof readOrganisationAccruedManual;addons?:typeof readOrganisationAccruedAddons;
    adjustments?:typeof readOrganisationAccruedAdjustments}={}):Promise<BillingOrganisationAccruedBillV1> {
  const account=await organisationFinancialAccount(selection,prisma);
  const period=await assertOrganisationBillPeriod(prisma,{organisationId:context.request.organisationId,
    accountId:account.id,month,now});
  const [manual,addons,phone]=await Promise.all([
    (deps.manual??readOrganisationAccruedManual)({organisationId:context.request.organisationId,accountId:account.id,period,observedAt:now},prisma),
    (deps.addons??readOrganisationAccruedAddons)({organisationId:context.request.organisationId,account,period,observedAt:now},prisma),
    prisma.billingCreditEntry.count({where:{creditAccount:{orgId:context.request.organisationId,accountId:account.id},
      kind:{in:['SMS_PREPAID_USAGE','VOICE_PREPAID_USAGE']},occurredAt:{gte:period.start,lt:period.asOf}}}),
  ]);
  if(phone)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_TELEPHONY_RECONCILIATION_REQUIRED');
  const subscriptions=await (deps.subscriptions??readOrganisationAccruedSubscriptions)({
    organisationId:context.request.organisationId,account,period,observedAt:now},prisma);
  if(subscriptions.lines.some(line=>line.product&&manual.coveredProducts.has(line.product)))
    throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_SUBSCRIPTION_COLLECTOR_CONFLICT');
  const adjustments=await (deps.adjustments??readOrganisationAccruedAdjustments)({organisationId:context.request.organisationId,
    accountId:account.id,period,noTaxProducts:subscriptions.noTaxProducts},prisma);
  const usage=await (deps.usage??readOrganisationAccruedUsage)({organisationId:context.request.organisationId,
    accountId:account.id,period,excludeProducts:manual.coveredProducts},prisma);
  for(const line of usage.lines.filter(line=>line.kind==='usage')){
    const prepaid=usage.lines.find(offset=>offset.product===line.product&&offset.kind==='prepaid_credit');
    if(line.amountMinor+(prepaid?.amountMinor??0n)>0n &&
      (!line.product||!subscriptions.noTaxProducts.has(line.product))) {
      throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_TAX_RECONCILIATION_REQUIRED');
    }
  }
  const paid=new Map(subscriptions.paid);
  for(const [currency,amount] of manual.paid)paid.set(currency,(paid.get(currency)??0n)+amount);
  for(const [currency,amount] of addons.paid)paid.set(currency,(paid.get(currency)??0n)+amount);
  const financial=organisationAccrualTotals([...subscriptions.lines,...manual.lines,...addons.lines,...usage.lines,...adjustments],paid,
    [...manual.currencies,...addons.currencies,...usage.currencies]);
  if(!financial.totals.length)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_SCOPE_UNPROVEN');
  return {as_of:now.toISOString(),period:{month,starts_at:period.start.toISOString(),
    ends_at:period.end.toISOString()},...financial};
}
