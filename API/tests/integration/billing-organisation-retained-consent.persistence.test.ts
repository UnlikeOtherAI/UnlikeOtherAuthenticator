import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { exportJWK,generateKeyPair } from 'jose';
import { createTestDb } from '../helpers/test-db.js';
import { ids,recovery,concurrency,seed,paymentIntent,stripeAccount as legacyAccount } from '../helpers/credit-auto-top-up-runtime-fixture.js';
import { claimCreditAutoTopUpAttempt,listCreditAutoTopUpCandidateIds } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import { runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { resolveOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import { requireStripeBillingEnabled,stripeRuntimeForAccount,resetStripeClientCache } from '../../src/services/billing-stripe-client.service.js';
const stripeAccount={...legacyAccount,stripeAccountId:'acct_AutoTopUpRuntime'};

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('retained TEAM consent after organisation cutover',()=>{
  let handle:NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async()=>{
    const db=await createTestDb();if(!db)throw Error('Disposable PG required');handle=db;
    // This existing fixture represents pre-cutover TEAM financial snapshots.
    // Its import bypasses triggers; every operation under test below uses the
    // actual production services with all current DB guards enabled.
    await seed(db.prisma,stripeAccount.stripeAccountId);
    for(const mode of ['LIVE','SANDBOX']){
      vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,stripeAccount.stripeAccountId);
      vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_current':'rk_test_current');
      vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,'whsec_current_'+mode);
    }
    vi.stubEnv('STRIPE_SECRET_KEY','rk_test_expired');vi.stubEnv('STRIPE_WEBHOOK_SECRET','whsec_legacy');vi.stubEnv('STRIPE_BILLING_ENABLED','true');
    vi.stubEnv('LEDGER_BILLING_BASE_URL','https://ledger.example.test');
    vi.stubEnv('LEDGER_BILLING_APP_KEY','lk_fixture_reader_00000000');vi.stubEnv('LEDGER_BILLING_APP_KEY_ID','tk_fixture');
    vi.stubEnv('LEDGER_BILLING_ASSERTION_AUDIENCE','https://ledger.example.test');
    const pair=await generateKeyPair('RS256',{extractable:true});
    vi.stubEnv('UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK',JSON.stringify({...await exportJWK(pair.privateKey),kid:'fixture',alg:'RS256'}));
    vi.stubEnv('UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON',JSON.stringify({keys:[{...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256'}]}));
  },120000);
  afterAll(async()=>{vi.restoreAllMocks();resetStripeClientCache();await handle?.cleanup();vi.unstubAllEnvs();});
  it('never creates a new attempt from a retained positive TEAM wallet and active consent',async()=>{
    const p=handle.prisma,before=await p.billingCreditAccount.findUniqueOrThrow({where:{id:concurrency.creditAccount}});
    expect(before).toMatchObject({scope:'TEAM',autoTopUpState:'ACTIVE',balanceMicrocredits:100000000n});
    expect((await resolveOrganisationBillingMode(ids.org,p)).mode).toBe('live');
    expect(await listCreditAutoTopUpCandidateIds({accountId:ids.account,limit:100},{prisma:p})).toEqual([]);
    expect(await claimCreditAutoTopUpAttempt({accountId:ids.account,creditAccountId:before.id},{prisma:p}))
      .toMatchObject({kind:'skipped',reason:'configuration_invalid'});
    const create=vi.fn().mockRejectedValue(Error('NEW TEAM CHARGE REFUSED'));
    expect(await runCreditAutoTopUpAccount({account:stripeAccount,creditAccountId:before.id},{prisma:p,stripe:{paymentIntents:{create}} as never}))
      .toMatchObject({outcome:'skipped',reason:'configuration_invalid'});
    expect(create).not.toHaveBeenCalled();expect(await p.billingCreditAutoTopUpAttempt.count()).toBe(0);
    expect(await p.billingCreditAccount.findUnique({where:{id:before.id}})).toEqual(before);
  });
  it('recovers an original captured pending attempt through fresh main TEST, never LIVE or a new consent',async()=>{
    const p=handle.prisma,before=await p.billingCreditAccount.findUniqueOrThrow({where:{id:recovery.creditAccount}});
    const epoch=(await resolveOrganisationBillingMode(ids.org,p)).epoch;
    const data={id:'historical-pending',accountId:ids.account,creditAccountId:before.id,catalogId:ids.catalog,
      serviceId:ids.service,appKeyId:ids.appKey,attributedUserId:ids.user,optionId:ids.option,offerId:ids.offer,
      consentRevisionId:before.autoTopUpConsentRevisionId!,consentVersion:before.autoTopUpConsentVersion!,
      thresholdMicrocredits:200000000n,monthlyChargeCapMinor:1500n,chargedThisMonthBeforeMinor:0n,observedBalanceMicrocredits:100000000n,
      paymentAmountMinor:500n,creditsReceivedMicrocredits:5000000000n,currency:'USD',billingMonth:new Date().toISOString().slice(0,7),
      idempotencyKey:'uoa:auto-top-up:historical-pending',createdAt:new Date(Date.parse(epoch)-1000)};
    await expect(p.billingCreditAutoTopUpAttempt.create({data})).rejects.toThrow('BILLING_ORGANISATION_MODE_CHANGED');
    // One immutable attempt existed before installation. This is fixture import,
    // not an allowed application creation path or a claimed capture-flow test.
    await p.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
      await tx.billingCreditAutoTopUpAttempt.create({data});});
    expect(await claimCreditAutoTopUpAttempt({accountId:ids.account,creditAccountId:before.id},{prisma:p}))
      .toMatchObject({kind:'dispatch',created:false,attemptId:data.id});
    const sandbox=stripeRuntimeForAccount(stripeAccount),live=requireStripeBillingEnabled('live');
    expect(sandbox.client).toBe(requireStripeBillingEnabled('sandbox').client);
    const create=vi.spyOn(sandbox.client.paymentIntents,'create').mockResolvedValue(paymentIntent(data.id,'recovery'));
    const wrong=vi.spyOn(live.client.paymentIntents,'create').mockRejectedValue(Error('LIVE MUST NOT REPLAY TEST'));
    expect(await runCreditAutoTopUpAccount({account:stripeAccount,creditAccountId:before.id},{prisma:p,stripe:sandbox.client}))
      .toMatchObject({outcome:'submitted',attemptId:data.id,stripePaymentIntentId:'pi_auto_top_up_recovery'});
    expect(create).toHaveBeenCalledOnce();expect(create.mock.calls[0]?.[1]).toEqual({idempotencyKey:data.idempotencyKey});
    expect(wrong).not.toHaveBeenCalled();expect(await p.billingCreditAutoTopUpAttempt.count()).toBe(1);
    expect(await p.billingCreditAccount.findUnique({where:{id:before.id}})).toEqual(before);
    expect(await p.billingCreditEntry.count()).toBe(0);
    expect((await resolveOrganisationBillingMode(ids.org,p)).mode).toBe('live');
  });
});
