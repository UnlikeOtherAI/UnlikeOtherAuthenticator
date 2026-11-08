import { Prisma,type PrismaClient } from '@prisma/client';
import type { BillingCreditAttentionV1 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import type { OrganisationBillingContext } from './billing-organisation-authority.service.js';
import type { OrganisationBillingSelection } from './billing-organisation-mode.service.js';
import { organisationFinancialAccount } from './billing-organisation-wallet.service.js';
import { ensureOrganisationCreditAccount } from './billing-credit-account.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { currentBillingCreditPeriod } from './billing-credit-projection-data.service.js';
import { buildBillingCreditAttention,resolveLatestBillingFundingCreditEntryId } from './billing-credit-funding-request.service.js';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';

/** Persisted provider-authored card expiry is immutable setup evidence. Missing
 * evidence is unknown, never a fabricated non-expired verdict. No provider call. */
export function organisationCardExpired(methodId:string|null,value:Prisma.JsonValue|null,now:Date):boolean {
  if(!methodId)return false;
  if(!value||typeof value!=='object'||Array.isArray(value)||value.type!=='card'||
    typeof value.exp_month!=='number'||!Number.isInteger(value.exp_month)||value.exp_month<1||value.exp_month>12||
    typeof value.exp_year!=='number'||!Number.isInteger(value.exp_year)||value.exp_year<1970||value.exp_year>9999) {
    throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_ATTENTION_PAYMENT_METHOD_UNPROVEN');
  }
  return value.exp_year<now.getUTCFullYear()||
    (value.exp_year===now.getUTCFullYear()&&value.exp_month<now.getUTCMonth()+1);
}

/** Current organisation wallet only. This reads no TEAM wallet, Ledger, FX,
 * Checkout readiness or Stripe SDK, and never claims settlement completeness. */
export async function readOrganisationAttention(context:OrganisationBillingContext,selection:OrganisationBillingSelection,
  prisma:PrismaClient,now:Date,deps:{financialAccount?:typeof organisationFinancialAccount}={}):Promise<BillingCreditAttentionV1[]> {
  const account=await (deps.financialAccount??organisationFinancialAccount)(selection,prisma);
  if(account.livemode!==(selection.mode==='live'))throw new AppError('INTERNAL',409,'BILLING_ATTENTION_ACCOUNT_MISMATCH');
  const wallet=await ensureOrganisationCreditAccount({account,organisationId:context.request.organisationId},{prisma});
  const period=currentBillingCreditPeriod(now);
  const effective=await resolveBillingTariffForMonth(prisma,{serviceId:context.credential.service.id,
    organisationId:context.request.organisationId,teamId:null,financialScope:'organisation',billingMonth:period.key});
  return prisma.$transaction(async tx=>{
    const current=await tx.billingCreditAccount.findUniqueOrThrow({where:{id:wallet.id},include:{
      autoTopUpConsentRevision:{include:{policy:true,option:{include:{refillOffer:true}}}}}});
    const consent=current.autoTopUpConsentRevision;
    if(consent&&(consent.accountId!==account.id||consent.creditAccountId!==current.id||consent.orgId!==current.orgId||
      consent.teamId!==null||consent.policyId!==current.autoTopUpPolicyId||consent.optionId!==current.autoTopUpOptionId||
      consent.refillOfferId!==current.autoTopUpRefillOfferId||consent.thresholdMicrocredits!==current.autoTopUpThresholdMicrocredits||
      consent.monthlyChargeCapMinor!==current.autoTopUpMonthlyChargeCapMinor||
      consent.stripePaymentMethodId!==current.stripePaymentMethodId||
      consent.refillPaymentAmountMinor!==consent.option.refillOffer.paymentAmountMinor)) {
      throw new AppError('INTERNAL',409,'BILLING_ATTENTION_CONSENT_RECONCILIATION_REQUIRED');
    }
    const policy=consent?{...consent.policy,autoTopUpOptions:[consent.option]}:
      await tx.billingCreditFundingPolicy.findFirst({where:{serviceId:context.credential.service.id,currency:'USD',active:true},
        orderBy:{version:'desc'},include:{autoTopUpOptions:{where:{active:true},include:{refillOffer:true}}}});
    if(!policy)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_ATTENTION_POLICY_NOT_CONFIGURED');
    const [reserved,latestFundingCreditEntryId,charged]=await Promise.all([
      billingReservedMicrocredits(tx,current.id),resolveLatestBillingFundingCreditEntryId({creditAccountId:current.id},{prisma:tx}),
      tx.billingCreditAutoTopUpAttempt.aggregate({where:{creditAccountId:current.id,billingMonth:period.key,
        status:'SUCCEEDED',currency:policy.currency},_sum:{paymentAmountMinor:true}}),
    ]);
    return buildBillingCreditAttention({creditAccountId:current.id,balanceMicrocredits:current.balanceMicrocredits-reserved,
      periodKey:period.key,meteredBilling:current.autoTopUpState!=='DISABLED'||
        (effective.tariff.mode!=='FREE'&&effective.tariff.collectionMode!=='NONE'),account:current,policy,
      chargedThisMonthMinor:charged._sum.paymentAmountMinor??0n,latestFundingCreditEntryId,
      paymentMethodExpired:organisationCardExpired(current.stripePaymentMethodId,current.paymentMethodSummary,now)});
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
}
