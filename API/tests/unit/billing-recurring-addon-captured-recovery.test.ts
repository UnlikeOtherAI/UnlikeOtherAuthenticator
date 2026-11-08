import { afterEach,describe,expect,it,vi } from 'vitest';
import { requireStripeBillingEnabled,resetStripeClientCache } from '../../src/services/billing-stripe-client.service.js';
import { confirmRecurringAddonCancellation } from '../../src/services/billing-recurring-addon-cancellation-confirm.service.js';
import { recurringAddonCancellationDigest,scopeForSubscription } from '../../src/services/billing-recurring-addon-cancellation-preview.service.js';
import { recurringAddonSubjectFingerprint } from '../../src/services/billing-recurring-addon-scope.service.js';
import { recurringAddonMetadata } from '../../src/services/billing-recurring-addon-stripe-binding.service.js';
const env=vi.hoisted(()=>({STRIPE_BILLING_ENABLED:true,STRIPE_SECRET_KEY:'rk_test_expired',STRIPE_WEBHOOK_SECRET:'whsec_legacy',
  STRIPE_LIVE_SECRET_KEY:'rk_live_current',STRIPE_LIVE_WEBHOOK_SECRET:'whsec_live',STRIPE_LIVE_ACCOUNT_ID:'acct_main',
  STRIPE_SANDBOX_SECRET_KEY:'rk_test_current',STRIPE_SANDBOX_WEBHOOK_SECRET:'whsec_test',STRIPE_SANDBOX_ACCOUNT_ID:'acct_main'}));
const authority=vi.hoisted(()=>({manager:true}));
vi.mock('../../src/config/env.js',async original=>({...await original<typeof import('../../src/config/env.js')>(),getEnv:()=>env}));
vi.mock('../../src/services/billing-entitlement.service.js',()=>({resolveFinancialTariffContext:async()=>({actor:{jti:'fresh'}})}));
vi.mock('../../src/services/billing-funding-viewer.service.js',()=>({resolveBillingFundingViewer:async()=>({billingManager:authority.manager})}));
const subject={product:'deepwater',organisationId:'org',teamId:'original-team',userId:'owner'};
const credential={id:'lifecycle',service:{id:'service',identifier:'deepwater',name:'DeepWater'}};
const token='uoa_cancel_original',key='original-idempotency';
const request={...subject,previewToken:token,idempotencyKey:key,choice:'cancel_addon' as const};
function fixture(){
  const account={id:'main-test',stripeAccountId:'acct_main',livemode:false};
  const checkout={id:'old-checkout',accountId:account.id,serviceId:'service',offerId:'offer',offerKey:'privacy',orgId:'org',
    scope:'TEAM',scopeKey:'org:original-team',teamId:'original-team',requestedTeamId:'original-team',subscribingUserId:null};
  const local={id:'old-subscription',checkoutId:checkout.id,accountId:account.id,livemode:false,customerId:'old-customer',catalogId:'old-catalog',
    serviceId:'service',offerId:'offer',offerKey:'privacy',orgId:'org',scope:'TEAM',scopeKey:checkout.scopeKey,teamId:'original-team',
    subscribingUserId:null,stripeSubscriptionId:'sub_original_test',stripeItemId:'si_original_test',status:'active',cancelAtPeriodEnd:false,
    entitlementActivatedAt:new Date('2026-10-01'),entitlementDeactivatedAt:null,updatedAt:new Date('2026-10-01'),checkout,
    customer:{id:'old-customer',accountId:account.id,orgId:'org',scope:'TEAM',scopeKey:checkout.scopeKey,teamId:'original-team',stripeCustomerId:'cus_original_test'},
    catalog:{stripePriceId:'price_original_test',currency:'USD',monthlyAmountMinor:5000n},
    offer:{currency:'USD',monthlyAmountMinor:5000n,featurePolicies:[{entitlementScope:'TEAM'}]}};
  const intent={id:'original-intent',accountId:account.id,subscriptionId:local.id,appKeyId:'lifecycle',serviceId:'service',orgId:'org',
    requestedTeamId:subject.teamId,requestedByUserId:'owner',idempotencyKey:key,state:'PROCESSING',
    subjectFingerprint:recurringAddonSubjectFingerprint({appKeyId:'lifecycle',serviceId:'service',offerId:'offer',subject,
      scope:scopeForSubscription(local as never)}),
    confirmationRequestDigest:recurringAddonCancellationDigest(JSON.stringify({product:subject.product,organisation_id:'org',
      team_id:subject.teamId,user_id:'owner',preview_token_digest:recurringAddonCancellationDigest(token),idempotency_key:key,choice:'cancel_addon'})),
    subscription:local};
  const remote={id:local.stripeSubscriptionId,object:'subscription',livemode:false,customer:'cus_original_test',status:'active',
    metadata:recurringAddonMetadata(checkout as never,account),cancel_at_period_end:false,discounts:[],
    items:{data:[{id:'si_original_test',quantity:1,discounts:[],current_period_start:1790812800,current_period_end:1793491200,
      price:{id:'price_original_test',recurring:{interval:'month',usage_type:'licensed'}}}]}};
  const prisma={billingStripeAccount:{findUnique:vi.fn().mockResolvedValue(account),upsert:vi.fn().mockResolvedValue(account)},
    billingRecurringAddonCancellationIntent:{findUnique:vi.fn().mockImplementation(async()=>intent),updateMany:vi.fn(async({data})=>{
      Object.assign(intent,data);return {count:1};})},
    billingRecurringAddonSubscription:{findFirst:vi.fn().mockResolvedValue(local),update:vi.fn(async({data})=>Object.assign(local,data))},
    orgAuditLog:{create:vi.fn()},$queryRaw:vi.fn().mockResolvedValue([{id:intent.id}]),
    $transaction:vi.fn(async(run:(tx:unknown)=>Promise<unknown>)=>run(prisma))};
  return {account,local,intent,remote,prisma};
}
describe('captured add-on confirmation recovery',()=>{
  afterEach(()=>{vi.restoreAllMocks();resetStripeClientCache();authority.manager=true;});
  it('recovers the original TEST customer through the fresh sandbox slot while default new work is LIVE',async()=>{
    const f=fixture(),sandbox=requireStripeBillingEnabled('sandbox'),live=requireStripeBillingEnabled('live');
    const accountRead=vi.spyOn(sandbox.client.accounts,'retrieveCurrent').mockResolvedValue({id:'acct_main'} as never);
    const read=vi.spyOn(sandbox.client.subscriptions,'retrieve').mockResolvedValue(f.remote as never);
    const write=vi.spyOn(sandbox.client.subscriptions,'update').mockResolvedValue({...f.remote,cancel_at_period_end:true} as never);
    const liveRead=vi.spyOn(live.client.subscriptions,'retrieve').mockRejectedValue(Error('LIVE MUST NOT RECONCILE TEST'));
    const liveWrite=vi.spyOn(live.client.subscriptions,'update').mockRejectedValue(Error('LIVE MUST NOT CANCEL TEST'));
    const params={request,actorToken:'fresh-manager-actor',credential:credential as never,endpoint:'/billing/v1/addons/cancellation/confirm' as never};
    const result=await confirmRecurringAddonCancellation(params,{prisma:f.prisma as never});
    expect(result.status).toBe('scheduled');expect(accountRead).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('sub_original_test',{cancel_at_period_end:true},{idempotencyKey:'uoa:recurring-addon-cancel:original-intent'});
    expect(liveRead).not.toHaveBeenCalled();expect(liveWrite).not.toHaveBeenCalled();
    expect(f.prisma.billingRecurringAddonSubscription.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({
      accountId:'main-test',customerId:'old-customer',checkoutId:'old-checkout',catalogId:'old-catalog',teamId:'original-team'})}));
    expect(f.prisma.billingStripeAccount.findUnique).toHaveBeenCalledWith({where:{id:'main-test'}});
    expect((await confirmRecurringAddonCancellation(params,{prisma:f.prisma as never})).status).toBe('scheduled');
    expect(write).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();
  });
  it('refuses altered original actor scope and revoked managers before provider recovery',async()=>{
    const f=fixture();const sandbox=requireStripeBillingEnabled('sandbox');
    const read=vi.spyOn(sandbox.client.subscriptions,'retrieve').mockRejectedValue(Error('MUST NOT READ'));
    const params={request:{...request,teamId:null},actorToken:'fresh',credential:credential as never,endpoint:{} as never};
    await expect(confirmRecurringAddonCancellation(params,{prisma:f.prisma as never})).rejects.toMatchObject({statusCode:403});
    authority.manager=false;
    await expect(confirmRecurringAddonCancellation({...params,request},{prisma:f.prisma as never})).rejects.toMatchObject({statusCode:403});
    expect(read).not.toHaveBeenCalled();expect(f.prisma.billingRecurringAddonCancellationIntent.updateMany).not.toHaveBeenCalled();
  });
});
