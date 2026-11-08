import type { PrismaClient } from '@prisma/client';
import { resolveOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';

/** All guards stay enabled: the saved consent is created by the actual setup
 * completion applier against exact captured UOA/webhook rows, without a payment. */
export async function seedOrganisationConsent(db:PrismaClient) {
  await db.user.create({data:{id:'control-owner',email:'control@example.test',userKey:'control@example.test'}});
  await db.organisation.create({data:{id:'control-org',name:'Controls',domain:'control.example.test',slug:'controls',ownerId:'control-owner'}});
  await db.orgMember.create({data:{orgId:'control-org',userId:'control-owner',role:'owner'}});
  await db.team.create({data:{id:'control-team',orgId:'control-org',name:'Selected',slug:'selected'}});
  await db.billingService.create({data:{id:'control-service',identifier:'control',name:'Controls'}});
  const credential=await db.billingAppKey.create({data:{id:'control-key',serviceId:'control-service',purpose:'CUSTOMER_LIFECYCLE',name:'Lifecycle',
    keyPrefix:'control',secretDigest:'a'.repeat(64),actorIssuer:'https://control.example.test',actorAudience:'https://uoa.example.test',
    actorKeyId:'control',actorPublicJwk:{kty:'RSA',n:'AQAB',e:'AQAB'},checkoutReturnOrigins:['https://control.example.test']},include:{service:true}});
  const account=await db.billingStripeAccount.create({data:{id:'control-live',stripeAccountId:'acct_Controls',livemode:true}});
  await db.billingStripeAccount.create({data:{id:'control-test',stripeAccountId:'acct_Controls',livemode:false}});
  await db.billingStripeCustomer.create({data:{id:'control-customer',accountId:account.id,orgId:'control-org',scope:'ORGANISATION',
    scopeKey:'control-org',stripeCustomerId:'cus_controls'}});
  await db.billingCreditAccount.create({data:{id:'control-wallet',accountId:account.id,customerId:'control-customer',orgId:'control-org',
    scope:'ORGANISATION',scopeKey:'control-org',currency:'USD'}});
  await db.billingCreditFundingPolicy.create({data:{id:'control-policy',serviceId:'control-service',currency:'USD',version:1,
    automaticConsentVersion:'control-v1',automaticTopUpEnabled:true,topUpEnabled:true}});
  await db.billingCreditTopUpOffer.create({data:{id:'control-offer',policyId:'control-policy',serviceId:'control-service',key:'refill',version:1,
    catalogKey:'control',catalogVersion:1,name:'Refill',description:'Refill',paymentAmountMinor:500n,creditsReceivedMicrocredits:5000000000n,automaticTopUpEligible:true}});
  await db.billingCreditAutoTopUpOption.create({data:{id:'control-option',policyId:'control-policy',serviceId:'control-service',refillOfferId:'control-offer',
    key:'automatic',version:1,thresholdMicrocredits:200000000n,monthlyChargeCapMinor:1500n}});
  await db.billingCreditTopUpCatalog.create({data:{id:'control-catalog',accountId:account.id,key:'control',version:1,currency:'USD',
    paymentAmountMinor:500n,creditsReceivedMicrocredits:5000000000n,stripeLookupKey:'control',stripeProductId:'prod_control',stripePriceId:'price_control'}});
  const selection=await resolveOrganisationBillingMode('control-org',db),now=new Date();
  await db.billingCustomerActionIntent.create({data:{appKeyId:credential.id,serviceId:'control-service',orgId:'control-org',teamId:'control-team',
    requestedByUserId:'control-owner',authorityScope:'ORGANISATION',operation:'credit_auto_top_up_setup',actorJti:'control-setup',actorTokenVersion:0,
    actorExpiresAt:new Date(now.getTime()+60000),requestDigest:'b'.repeat(64)}});
  await db.billingCreditSetupCheckout.create({data:{id:'control-setup',accountId:account.id,creditAccountId:'control-wallet',customerId:'control-customer',
    serviceId:'control-service',appKeyId:credential.id,policyId:'control-policy',optionId:'control-option',actorJti:'control-setup',requestedByUserId:'control-owner',
    expectedGeneration:0,consentVersion:'control-v1',thresholdMicrocredits:200000000n,refillOfferId:'control-offer',refillCreditsMicrocredits:5000000000n,
    refillPaymentAmountMinor:500n,monthlyChargeCapMinor:1500n,successUrlDigest:'c'.repeat(64),cancelUrlDigest:'d'.repeat(64),
    leaseExpiresAt:new Date(now.getTime()+60000),billingModeTeamId:'control-team',
    billingModeRevision:selection.revision,billingScopeEpoch:new Date(selection.epoch)}});
  await db.billingCreditSetupCheckout.update({where:{id:'control-setup'},data:{stripeCheckoutSessionId:'cs_controls',status:'OPEN'}});
  const event=await db.billingStripeWebhookEvent.create({data:{accountId:account.id,stripeEventId:'evt_control_setup',type:'setup_intent.succeeded',
    livemode:true,stripeCreatedAt:now,stripeObjectId:'seti_controls',stripeObjectStatus:'succeeded',stripeCustomerId:'cus_controls',
    stripeCheckoutSessionId:'cs_controls',stripeSetupIntentId:'seti_controls',stripePaymentMethodId:'pm_controls'}});
  await db.$transaction(tx=>applyCreditFundingWebhook(tx,{event:{kind:'setup_succeeded',localId:'control-setup',
    setupIntent:{id:'seti_controls',customer:'cus_controls'} as never,checkoutSessionId:'cs_controls',paymentMethodId:'pm_controls',
    paymentMethodSummary:{type:'card',brand:'visa',last4:'4242',exp_month:12,exp_year:2035},occurredAt:now},eventFields:{stripeCreatedAt:now}},event.id,account));
  return {credential,account,selection};
}
