import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale, BillingOrganisationCreditBalanceV1, BillingOrganisationFundingV1 }
  from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { ensureOrganisationCreditAccount, resolveCreditCollectionContext } from './billing-credit-account.service.js';
import { billingCreditAmount } from './billing-credit-display.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { currentBillingCreditPeriod, loadBillingCreditProjectionData } from './billing-credit-projection-data.service.js';
import { resolveBillingCreditActionReadiness } from './billing-credit-action-readiness.service.js';
import { buildManagerCreditActionsProjection } from './billing-credit-action-projection.service.js';
import { billingCreditCopy } from './billing-credit-copy.catalog.js';
import { freezeDisplayedBillingActions } from './billing-action-context.service.js';
import { billingModeRefreshCopy } from './billing-mode-copy.catalog.js';
import { readOrganisationBillingRegion } from './billing-organisation-region.service.js';
import { readCreditPurchaseRateWithAlert } from './billing-credit-purchase-rate.service.js';
import { billingOrganisationCopy } from './billing-organisation-copy.catalog.js';
import type { OrganisationBillingContext } from './billing-organisation-authority.service.js';
import type { OrganisationBillingSelection } from './billing-organisation-mode.service.js';
import { readOrganisationFundingControls } from './billing-organisation-funding-controls.service.js';
import { organisationFinancialAccount } from './billing-organisation-financial-account.service.js';
export { organisationFinancialAccount } from './billing-organisation-financial-account.service.js';

/** A DB snapshot of confirmed money and holds, with no provider/FX/Ledger dependency. */
export async function readOrganisationCreditBalance(context:OrganisationBillingContext,
  selection:OrganisationBillingSelection,prisma:PrismaClient,locale?:BillingCustomerLocale,
  deps:{financialAccount?:typeof organisationFinancialAccount}={}):Promise<BillingOrganisationCreditBalanceV1> {
  const account=await (deps.financialAccount??organisationFinancialAccount)(selection,prisma);
  if(account.livemode!==(selection.mode==='live'))throw new AppError('INTERNAL',409,'BILLING_CREDIT_ACCOUNT_MODE_MISMATCH');
  const wallet=await ensureOrganisationCreditAccount({account,organisationId:context.request.organisationId},{prisma});
  return prisma.$transaction(async tx=>{
    const current=await tx.billingCreditAccount.findUniqueOrThrow({where:{id:wallet.id}});
    const period=currentBillingCreditPeriod(new Date());
    const [reserved,unsettled,retained,changed]=await Promise.all([billingReservedMicrocredits(tx,wallet.id),
      tx.billingCreditSettlementWatch.count({where:{creditAccountId:wallet.id,
        OR:[{lastCheckedAt:null},{lastError:{not:null}}]}}),
      tx.billingCreditAccount.count({where:{orgId:context.request.organisationId,teamId:{not:null},
        OR:[{balanceMicrocredits:{not:0n}},{autoTopUpConsentRevisionId:{not:null}}]}}),
      tx.billingOrganisationModeEvent.count({where:{orgId:context.request.organisationId,
        effectiveAt:{gte:period.startsAt,lt:period.endsAt}}})]);
    const epochMonth=selection.epoch.slice(0,7);
    const pending=unsettled>0 || retained>0 || changed>0 || period.key===epochMonth;
    const copy=billingOrganisationCopy(locale);
    return {credit_account_id:wallet.id,confirmed_balance:billingCreditAmount(current.balanceMicrocredits,locale),
      reserved_credits:billingCreditAmount(reserved,locale),
      spendable_balance:billingCreditAmount(current.balanceMicrocredits-reserved,locale),as_of:new Date().toISOString(),
      billing_status:{settlement_state:pending?'pending_reconciliation':'current',
        message:retained>0?`${copy.balancePending} ${copy.retained}`:pending?copy.balancePending:copy.balance}};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
}

/** Funding controls reuse canonical price/consent validation; no metering call occurs. */
export async function readOrganisationFunding(context:OrganisationBillingContext,
  selection:OrganisationBillingSelection,prisma:PrismaClient,locale:BillingCustomerLocale|undefined,now:Date,
  deps:{purchase?:typeof readOrganisationPurchaseFunding}={}):Promise<BillingOrganisationFundingV1> {
  try{return await (deps.purchase??readOrganisationPurchaseFunding)(context,selection,prisma,locale,now);}
  catch(error){
    if(error instanceof AppError&&(error.statusCode===401||error.statusCode===403))throw error;
    const controls=await readOrganisationFundingControls(context,selection,prisma,locale,now);
    // Keep the established first-purchase region doorway. An existing consent
    // can always be disabled even if its organisation has no region yet.
    if(error instanceof AppError&&error.message==='BILLING_REGION_REQUIRED'&&!controls.automatic_top_up.disable_action?.enabled)throw error;
    return controls;
  }
}
async function readOrganisationPurchaseFunding(context:OrganisationBillingContext,
  selection:OrganisationBillingSelection,prisma:PrismaClient,locale:BillingCustomerLocale|undefined,now:Date):Promise<BillingOrganisationFundingV1> {
  const collection=await resolveCreditCollectionContext(context.request,{prisma});
  const wallet=await ensureOrganisationCreditAccount({account:collection.account,organisationId:context.request.organisationId},{prisma});
  const region=await readOrganisationBillingRegion(context.request.organisationId,prisma);
  if(!region)throw new AppError('BAD_REQUEST',409,'BILLING_REGION_REQUIRED');
  const currency=region.currency;
  const period=currentBillingCreditPeriod(now);
  const data=await loadBillingCreditProjectionData({creditAccountId:wallet.id,teamId:context.request.teamId,
    accountId:collection.account.id,storefrontServiceId:context.credential.service.id,period,
    purchaseCurrency:currency,reloadCurrency:currency},{prisma});
  if(!data.policy)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_FUNDING_POLICY_NOT_CONFIGURED');
  const readiness=await resolveBillingCreditActionReadiness({collection,credential:context.credential,data});
  const rate=currency==='USD'||!collection.stripe||!collection.stripeCollectionEnabled?null:
    await readCreditPurchaseRateWithAlert(currency,{prisma,stripe:collection.stripe,now:()=>now});
  const actions=buildManagerCreditActionsProjection(data,{product:context.request.product,
    organisation_id:context.request.organisationId,team_id:context.request.teamId,user_id:context.request.userId},
    collection.stripeCollectionEnabled,readiness,period.endsAt,locale,rate);
  const result:BillingOrganisationFundingV1={...actions,capabilities:{
    can_top_up:actions.funding_policy.offers.some(o=>o.action.enabled),
    can_manage_automatic_top_up:actions.automatic_top_up.options.some(o=>o.setup_action.enabled||o.update_action.enabled)
      ||Boolean(actions.automatic_top_up.disable_action?.enabled||actions.automatic_top_up.recover_action?.enabled)},
    conversion:{credits_per_usd:'1000',settlement_currency:'USD',description:billingCreditCopy(locale).conversionDescription},
    collection:{stripe_collection_enabled:collection.stripeCollectionEnabled,stripe_mode:collection.account.livemode?'live':'test'}};
  return freezeDisplayedBillingActions(result,{account:collection.account,revision:selection.revision,
    scopeEpoch:selection.epoch,appKeyId:context.credential.id},true,billingModeRefreshCopy(locale),now);
}
