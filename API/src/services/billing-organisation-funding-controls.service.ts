import { Prisma,type PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import type { BillingCustomerLocale,BillingOrganisationFundingV1 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { ensureOrganisationCreditAccount } from './billing-credit-account.service.js';
import { currentBillingCreditPeriod } from './billing-credit-projection-data.service.js';
import { billingCreditAmount,billingCreditsPaymentMoney } from './billing-credit-display.service.js';
import { billingCreditAutoTopUpCopy } from './billing-credit-auto-top-up-copy.catalog.js';
import { billingCreditFundingCopy } from './billing-credit-funding-copy.catalog.js';
import { billingCreditCopy } from './billing-credit-copy.catalog.js';
import { freezeDisplayedBillingActions } from './billing-action-context.service.js';
import { billingModeRefreshCopy } from './billing-mode-copy.catalog.js';
import { organisationFundingCopy } from './billing-organisation-funding-copy.catalog.js';
import { organisationFinancialAccount } from './billing-organisation-financial-account.service.js';
import type { OrganisationBillingContext } from './billing-organisation-authority.service.js';
import type { OrganisationBillingSelection } from './billing-organisation-mode.service.js';

/** Source-owned partial funding projection. Empty offers/options mean none can
 * be quoted now; the saved consent and its disable action need no Stripe/FX read. */
export async function readOrganisationFundingControls(context:OrganisationBillingContext,selection:OrganisationBillingSelection,
  prisma:PrismaClient,locale:BillingCustomerLocale|undefined,now:Date):Promise<BillingOrganisationFundingV1> {
  const account=await organisationFinancialAccount(selection,prisma);
  const wallet=await ensureOrganisationCreditAccount({account,organisationId:context.request.organisationId},{prisma});
  const result=await prisma.$transaction(async tx=>{
    const current=await tx.billingCreditAccount.findUniqueOrThrow({where:{id:wallet.id},include:{
      autoTopUpConsentedBy:{select:{name:true}},autoTopUpConsentRevision:{include:{policy:true,option:{include:{refillOffer:true}}}}}});
    const consent=current.autoTopUpConsentRevision;
    if(current.orgId!==context.request.organisationId||current.scope!=='ORGANISATION'||current.teamId!==null||current.accountId!==account.id||
      (!consent&&current.autoTopUpState!=='DISABLED')||consent&&(consent.accountId!==account.id||consent.creditAccountId!==current.id||
      consent.orgId!==current.orgId||consent.teamId!==null||consent.policyId!==current.autoTopUpPolicyId||consent.optionId!==current.autoTopUpOptionId||
      consent.refillOfferId!==current.autoTopUpRefillOfferId||consent.thresholdMicrocredits!==current.autoTopUpThresholdMicrocredits||
      consent.monthlyChargeCapMinor!==current.autoTopUpMonthlyChargeCapMinor||consent.stripePaymentMethodId!==current.stripePaymentMethodId||
      consent.refillPaymentAmountMinor!==consent.option.refillOffer.paymentAmountMinor||consent.policyId!==consent.option.policyId||
      consent.policyId!==consent.option.refillOffer.policyId))
      throw new AppError('INTERNAL',409,'BILLING_FUNDING_CONSENT_RECONCILIATION_REQUIRED');
    const period=currentBillingCreditPeriod(now),currency=consent?.policy.currency??'USD';
    if(currency!=='USD'&&currency!=='EUR'&&currency!=='GBP')throw new AppError('INTERNAL',409,'BILLING_FUNDING_CONSENT_CURRENCY_UNPROVEN');
    const charged=await tx.billingCreditAutoTopUpAttempt.aggregate({where:{creditAccountId:current.id,billingMonth:period.key,
      currency,status:'SUCCEEDED'},_sum:{paymentAmountMinor:true}});
    const amount=charged._sum.paymentAmountMinor??0n,cap=consent?.monthlyChargeCapMinor??null;
    const remaining=cap===null?null:cap>amount?cap-amount:0n;
    const paused=current.autoTopUpState==='ACTIVE'&&consent&&remaining!==null&&remaining<consent.refillPaymentAmountMinor;
    const state=paused?'paused':current.autoTopUpState.toLowerCase() as 'disabled'|'active'|'paused'|'requires_action'|'needs_review';
    const copy=billingCreditAutoTopUpCopy(locale),funding=billingCreditFundingCopy(locale),partial=organisationFundingCopy(locale);
    const disable=consent&&current.autoTopUpState!=='DISABLED';
    return {capabilities:{can_top_up:false,can_manage_automatic_top_up:Boolean(disable)},
      funding_policy:{top_up_enabled:false,automatic_top_up_enabled:false,title:funding.title,description:partial.offersUnavailable,offers:[]},
      automatic_top_up:{state,display_status:copy.status[state],description:`${partial.offersUnavailable} ${partial.savedCurrency}`,
        threshold:consent&&currency==='USD'?billingCreditAmount(consent.thresholdMicrocredits,locale):null,
        ...(consent?.thresholdAmountMinor!==null&&consent?.thresholdAmountMinor!==undefined?
          {threshold_value:billingCreditsPaymentMoney(consent.thresholdAmountMinor,locale,currency)}:{}),
        refill_offer_id:consent?.refillOfferId??null,monthly_cap:cap===null?null:billingCreditsPaymentMoney(cap,locale,currency),
        charged_this_month:billingCreditsPaymentMoney(amount,locale,currency),
        remaining_monthly_cap:remaining===null?null:billingCreditsPaymentMoney(remaining,locale,currency),
        payment_method:{status:current.stripePaymentMethodId?'requires_action' as const:'missing' as const,
          display:current.stripePaymentMethodId?copy.savedPaymentMethod:copy.noSavedPaymentMethod},
        consent:{status:consent?consent.policy.active&&consent.consentVersion===consent.policy.automaticConsentVersion?'current' as const:'outdated' as const:'missing' as const,
          version:consent?.consentVersion??null,consented_at:consent?.consentedAt.toISOString()??null,
          consented_by:consent?{display_name:current.autoTopUpConsentedBy?.name??copy.consentedByFallback}:null,description:copy.consentDescription},
        options:[],recover_action:null,disable_action:disable?{id:'auto_top_up_disable' as const,kind:'mutation' as const,label:copy.disableAction,
          description:copy.disableDescription,enabled:true,disabled_reason:null,request:{method:'POST' as const,path:'/billing/v1/credits/auto-top-up/disable' as const,
            body:{product:context.request.product,organisation_id:context.request.organisationId,team_id:context.request.teamId,user_id:context.request.userId}}}:null},
      conversion:{credits_per_usd:'1000' as const,settlement_currency:'USD' as const,description:billingCreditCopy(locale).conversionDescription},
      collection:{stripe_collection_enabled:getEnv().STRIPE_BILLING_ENABLED,stripe_mode:account.livemode?'live' as const:'test' as const}};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  return freezeDisplayedBillingActions(result,{account,revision:selection.revision,scopeEpoch:selection.epoch,appKeyId:context.credential.id},
    true,billingModeRefreshCopy(locale),now);
}
