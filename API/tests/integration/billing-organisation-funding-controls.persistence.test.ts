import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { createRlsTestDb } from '../helpers/test-db.js';
import { seedOrganisationConsent } from '../helpers/organisation-consent-fixture.js';
import { readOrganisationFunding } from '../../src/services/billing-organisation-wallet.service.js';
import { disableBillingCreditAutoTopUp } from '../../src/services/billing-credit-auto-top-up-consent.service.js';
import { billingOrganisationOverviewV1ConformanceFixture,billingOrganisationOverviewV1JsonSchema } from '../../src/contracts/billing-statement-v1.js';
import type { OrganisationBillingContext } from '../../src/services/billing-organisation-authority.service.js';
import { AppError } from '../../src/utils/errors.js';
import { claimCreditAutoTopUpAttempt } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import { runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';

vi.mock('../../src/services/billing-actor.service.js',()=>({verifyBillingActor:async({request}:{request:{userId:string}})=>({
  sub:request.userId,tv:0,jti:'control-disable',exp:Math.floor(Date.now()/1000)+60})}));
const validator=new Ajv2020({strict:true,allErrors:true});ajvFormats.default.default(validator);
const validate=validator.compile(billingOrganisationOverviewV1JsonSchema);
describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('independent organisation consent controls',()=>{
  let handle:NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>,seed:Awaited<ReturnType<typeof seedOrganisationConsent>>;
  let context:OrganisationBillingContext;
  beforeAll(async()=>{
    const db=await createRlsTestDb();if(!db)throw Error('Disposable PG required');handle=db;
    vi.stubEnv('STRIPE_LIVE_ACCOUNT_ID','acct_Controls');vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID','acct_Controls');
    vi.stubEnv('STRIPE_LIVE_SECRET_KEY','rk_live_control');vi.stubEnv('STRIPE_SANDBOX_SECRET_KEY','rk_test_control');
    vi.stubEnv('STRIPE_LIVE_WEBHOOK_SECRET','whsec_live_control');vi.stubEnv('STRIPE_SANDBOX_WEBHOOK_SECRET','whsec_test_control');
    vi.stubEnv('STRIPE_BILLING_ENABLED','false');seed=await seedOrganisationConsent(db.prisma);
    context={credential:seed.credential as never,request:{product:'control',organisationId:'control-org',teamId:'control-team',userId:'control-owner'},
      actorToken:'signature-proof-owned-by-actor-suite',endpoint:'/billing/v1/organisation/overview'};
  },120000);
  afterAll(async()=>{await handle?.cleanup();vi.unstubAllEnvs();});
  it.each(['BILLING_PURCHASE_RATE_UNAVAILABLE','STRIPE_CREDIT_PRICE_UNAVAILABLE'])('retains exact saved consent and disable without %s',async code=>{
    const result=await readOrganisationFunding(context,seed.selection,handle.prisma,'en-US',new Date(),{
      purchase:async()=>{throw new AppError('SERVICE_UNAVAILABLE',503,code);}});
    expect(result).toMatchObject({funding_policy:{offers:[],top_up_enabled:false},automatic_top_up:{state:'active',options:[],
      monthly_cap:{currency:'USD',amount_minor:'1500'},disable_action:{enabled:true}},capabilities:{can_top_up:false,can_manage_automatic_top_up:true}});
    expect(result.automatic_top_up.disable_action?.request.body.billing_context).toBeTruthy();
    const overview=structuredClone(billingOrganisationOverviewV1ConformanceFixture);
    overview.sections.funding={state:'confirmed',message:'Saved automatic top-up settings.',data:result};
    expect(validate(overview),JSON.stringify(validate.errors)).toBe(true);
    expect(await handle.prisma.billingCreditAutoTopUpAttempt.count()).toBe(0);
  });
  it('claims one new automatic refill for the exact ORG payer and replays only the captured attempt',async()=>{
    const p=handle.prisma;
    const claim=await claimCreditAutoTopUpAttempt({accountId:seed.account.id,creditAccountId:'control-wallet'},{prisma:p});
    expect(claim).toMatchObject({kind:'dispatch',created:true,creditAccountId:'control-wallet'});
    const replay=await claimCreditAutoTopUpAttempt({accountId:seed.account.id,creditAccountId:'control-wallet'},{prisma:p});
    expect(replay).toMatchObject({kind:'dispatch',created:false,attemptId:claim.kind==='dispatch'?claim.attemptId:undefined});
    expect(await p.billingCreditAutoTopUpAttempt.count()).toBe(1);expect(await p.billingCreditEntry.count()).toBe(0);
  });
  it('requires the original displayed context and current manager, then disables through actual DB guards without collection/provider/FX',async()=>{
    const p=handle.prisma,result=await readOrganisationFunding(context,seed.selection,p,'en-US',new Date(),{
      purchase:async()=>{throw Error('OFFERS UNAVAILABLE');}});
    const displayed=result.automatic_top_up.disable_action!.request.body;
    const params={...context,endpoint:'/billing/v1/credits/auto-top-up/disable' as const,
      request:{...context.request,billingContext:displayed.billing_context}};
    await expect(disableBillingCreditAutoTopUp({...params,request:{...params.request,billingContext:undefined}},{prisma:p}))
      .rejects.toThrow('BILLING_CONTEXT_REQUIRED');
    await p.orgMember.update({where:{orgId_userId:{orgId:'control-org',userId:'control-owner'}},data:{status:'REMOVED'}});
    await expect(disableBillingCreditAutoTopUp(params,{prisma:p})).rejects.toMatchObject({statusCode:403});
    await p.orgMember.update({where:{orgId_userId:{orgId:'control-org',userId:'control-owner'}},data:{status:'ACTIVE'}});
    await disableBillingCreditAutoTopUp(params,{prisma:p});
    expect(await p.billingCreditAccount.findUniqueOrThrow({where:{id:'control-wallet'}})).toMatchObject({autoTopUpState:'DISABLED',autoTopUpConsentRevisionId:null});
    expect(await p.billingCreditAutoTopUpDisableEvent.count()).toBe(1);expect(await p.billingCreditAutoTopUpConsentRevision.count()).toBe(1);
    expect(await p.billingCreditEntry.count()).toBe(0);expect(await p.billingCreditAutoTopUpAttempt.count()).toBe(1);
    const create=vi.fn().mockRejectedValue(Error('DISABLED CONSENT MUST NOT CHARGE'));
    expect(await runCreditAutoTopUpAccount({account:seed.account,creditAccountId:'control-wallet'},
      {prisma:p,stripe:{paymentIntents:{create}} as never})).toMatchObject({outcome:'skipped',reason:'consent_changed'});
    expect(create).not.toHaveBeenCalled();
    await expect(readOrganisationFunding(context,seed.selection,p,'en-US',new Date(),{
      purchase:async()=>{throw new AppError('BAD_REQUEST',409,'BILLING_REGION_REQUIRED');}})).rejects.toThrow('BILLING_REGION_REQUIRED');
  });
});
