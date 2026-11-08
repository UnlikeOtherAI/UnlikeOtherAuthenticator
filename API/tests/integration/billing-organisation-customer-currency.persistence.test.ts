import { createHash,generateKeyPairSync } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import type Stripe from 'stripe';
import { createTestDb } from '../helpers/test-db.js';
import { seedOrganisationConsent } from '../helpers/organisation-consent-fixture.js';
import { createStripeCheckoutSession } from '../../src/services/billing-stripe-checkout.service.js';
import { createRecurringAddonCheckout } from '../../src/services/billing-recurring-addon-checkout.service.js';
import { mintBillingActionContext } from '../../src/services/billing-action-context.service.js';
import { requireStripeBillingEnabled,resetStripeClientCache } from '../../src/services/billing-stripe-client.service.js';
import { recurringAddonScope,recurringAddonSubjectFingerprint } from '../../src/services/billing-recurring-addon-scope.service.js';
const mocks=vi.hoisted(()=>({resolve:vi.fn()}));
vi.mock('../../src/services/billing-entitlement.service.js',async original=>({
  ...await original<typeof import('../../src/services/billing-entitlement.service.js')>(),resolveFinancialTariffContext:mocks.resolve}));
vi.mock('../../src/services/billing-stripe-catalog.service.js',()=>({ensureStripeCatalog:async()=>({id:'catalog',stripeUsagePriceId:'price_usage'}),
  ensureStripeTariffPrice:async()=>({stripeMonthlyPriceId:'price_monthly'})}));
vi.mock('../../src/services/billing-recurring-addon-catalog.service.js',()=>({ensureRecurringAddonStripeCatalog:async({catalog}:{catalog:unknown})=>catalog}));

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('ORG subscription currency customer selection',()=>{
  let handle:NonNullable<Awaited<ReturnType<typeof createTestDb>>>,seed:Awaited<ReturnType<typeof seedOrganisationConsent>>;
  let client:Stripe,sequence=0;
  const remoteCustomers=new Map<string,unknown>(),sessions=new Map<string,unknown>();
  const subject={product:'control',organisationId:'control-org',teamId:'control-team',userId:'control-owner'};
  const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  function token(path:string,body:Record<string,unknown>){return mintBillingActionContext({account:seed.account,
    revision:seed.selection.revision,scopeEpoch:seed.selection.epoch,appKeyId:seed.credential.id},path,body);}
  beforeAll(async()=>{
    const db=await createTestDb();if(!db)throw Error('Disposable PG required');handle=db;seed=await seedOrganisationConsent(db.prisma);
    vi.stubEnv('STRIPE_BILLING_ENABLED','true');
    vi.stubEnv('LEDGER_BILLING_BASE_URL','https://ledger.example.test');
    vi.stubEnv('LEDGER_BILLING_APP_KEY','lk_fixture_unused_collector');vi.stubEnv('LEDGER_BILLING_APP_KEY_ID','tk_fixture_collector');
    vi.stubEnv('LEDGER_BILLING_ASSERTION_AUDIENCE','https://ledger.example.test');
    const pair=generateKeyPairSync('rsa',{modulusLength:2048}),kid='currency-fixture';
    vi.stubEnv('UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK',JSON.stringify({...pair.privateKey.export({format:'jwk'}),kid}));
    vi.stubEnv('UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON',JSON.stringify({keys:[{...pair.publicKey.export({format:'jwk'}),kid}]}));
    for(const mode of ['LIVE','SANDBOX']){
      vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,seed.account.stripeAccountId);
      vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_currency_fixture':'rk_test_currency_fixture');
      vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,`whsec_currency_${mode}`);
    }
    await db.prisma.billingTariff.create({data:{id:'currency-eur',serviceId:'control-service',key:'standard',version:1,name:'Standard',
      mode:'STANDARD',collectionMode:'STRIPE',markupBps:3000,currency:'EUR',monthlyAmountMinor:299n}});
    await db.prisma.app.create({data:{id:'currency-app',orgId:'control-org',name:'Control',identifier:'currency-control',platform:'web'}});
    await db.prisma.featureFlagDefinition.create({data:{appId:'currency-app',key:'privacy'}});
    await db.prisma.billingRecurringAddonOffer.create({data:{id:'currency-addon',serviceId:'control-service',key:'privacy',version:1,
      name:'Privacy',description:'Privacy',currency:'USD',monthlyAmountMinor:5000n}});
    await db.prisma.billingRecurringAddonFeaturePolicy.create({data:{serviceId:'control-service',offerId:'currency-addon',appId:'currency-app',
      featureFlagKey:'privacy',entitlementScope:'TEAM'}});
    await db.prisma.billingRecurringAddonCatalog.create({data:{id:'currency-addon-catalog',accountId:seed.account.id,serviceId:'control-service',
      offerId:'currency-addon',currency:'USD',monthlyAmountMinor:5000n,stripeLookupKey:'currency-privacy',stripeProductId:'prod_privacy',stripePriceId:'price_privacy'}});
    mocks.resolve.mockImplementation(async()=>({actor:{jti:`currency-actor-${++sequence}`,tv:0,exp:Math.floor(Date.now()/1000)+120},payload:{
      product:{id:'control-service',identifier:'control'},subject:{product:'control',organisation_id:'control-org',team_id:'control-team',user_id:'control-owner'},
      tariff:{id:'currency-eur',mode:'standard',collection_mode:'stripe',monthly_subscription:{amount_minor:'299',currency:'EUR'},
        payment_collection_enabled:true,usage_billing_enabled:true,raw_usage_preserved:true,usage_payment_mode:'prepaid'},
      assignment:{scope:'service_default',id:null}}}));
    client=requireStripeBillingEnabled('live').client;
    vi.spyOn(client.accounts,'retrieveCurrent').mockResolvedValue({id:seed.account.stripeAccountId} as never);
    vi.spyOn(client.customers,'create').mockImplementation(async input=>{
      const row={id:`cus_currency_${remoteCustomers.size}`,object:'customer',livemode:true,metadata:input!.metadata};
      remoteCustomers.set(row.id,row);return row as never;
    });
    remoteCustomers.set('cus_controls',{id:'cus_controls',livemode:true,metadata:{uoa_scope:'organisation',uoa_scope_key:'control-org',
      uoa_organisation_id:'control-org',uoa_stripe_account_id:seed.account.stripeAccountId,uoa_stripe_mode:'live'}});
    vi.spyOn(client.customers,'retrieve').mockImplementation(async id=>remoteCustomers.get(id) as never);
    vi.spyOn(client.checkout.sessions,'create').mockImplementation(async input=>{
      const row={...input,id:`cs_currency_${sessions.size}`,status:'open',livemode:true,url:'https://checkout.stripe.com/c/pay/currency',
        expires_at:Math.floor(Date.now()/1000)+1800};sessions.set(row.id,row);return row as never;
    });
    vi.spyOn(client.checkout.sessions,'retrieve').mockImplementation(async id=>sessions.get(id) as never);
    vi.spyOn(client.checkout.sessions,'list').mockResolvedValue({data:[],has_more:false} as never);
  });
  afterAll(async()=>{await handle?.cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();resetStripeClientCache();});
  it('creates EUR base and USD entitlement checkouts for one ORG payer while funding keeps its original customer',async()=>{
    const path='/billing/v1/stripe/checkout-session',success='https://control.example.test/?uoa_billing=checkout_success',
      cancel='https://control.example.test/?uoa_billing=checkout_cancel';
    const body={product:'control',organisation_id:'control-org',team_id:'control-team',user_id:'control-owner',success_url:success,cancel_url:cancel};
    await createStripeCheckoutSession({request:{...subject,successUrl:success,cancelUrl:cancel,billingContext:token(path,body)},
      actorToken:'signature-boundary-owned-by-actor-suite',credential:seed.credential as never,endpoint:path},{prisma:handle.prisma});
    const addonPath='/billing/v1/recurring-addons/checkout',addonBody={product:'control',organisation_id:'control-org',team_id:'control-team',
      user_id:'control-owner',offer_id:'currency-addon'};
    await createRecurringAddonCheckout({request:{...subject,offerId:'currency-addon',billingContext:token(addonPath,addonBody)},actorToken:'verified',
      credential:seed.credential as never,endpoint:addonPath},{prisma:handle.prisma});
    const base=await handle.prisma.billingStripeCheckoutSession.findFirstOrThrow({include:{customer:true}}),
      addon=await handle.prisma.billingRecurringAddonCheckout.findFirstOrThrow({include:{customer:true}});
    expect(base).toMatchObject({accountId:seed.account.id,scope:'ORGANISATION',teamId:null,scopeKey:'control-org',
      billingScopeEpoch:new Date(seed.selection.epoch),customer:{scopeKey:'control-org:billing:EUR',teamId:null}});
    expect(addon).toMatchObject({accountId:seed.account.id,scope:'TEAM',teamId:'control-team',billingScopeEpoch:new Date(seed.selection.epoch),
      customer:{scope:'ORGANISATION',scopeKey:'control-org:billing:USD',teamId:null}});
    expect(base.customerId).not.toBe(addon.customerId);expect(base.customer.stripeCustomerId).not.toBe(addon.customer.stripeCustomerId);
    expect(await handle.prisma.teamMember.count({where:{userId:'control-owner'}})).toBe(0);
    expect(await handle.prisma.billingCreditAccount.findUniqueOrThrow({where:{id:'control-wallet'}}))
      .toMatchObject({customerId:'control-customer',balanceMicrocredits:0n,autoTopUpState:'ACTIVE'});
    expect(await handle.prisma.billingCreditEntry.count()).toBe(0);
  });
  it('recovers a previously captured canonical ORG customer without switching it to the new currency slot',async()=>{
    const p=handle.prisma;await p.team.create({data:{id:'currency-recovery-team',orgId:'control-org',name:'Recovery',slug:'recovery'}});
    const capturedSubject={...subject,teamId:'currency-recovery-team'},scope=recurringAddonScope('TEAM',capturedSubject);
    await p.billingCustomerActionIntent.create({data:{appKeyId:seed.credential.id,serviceId:'control-service',orgId:'control-org',
      teamId:capturedSubject.teamId,requestedByUserId:'control-owner',authorityScope:'ORGANISATION',operation:'recurring_addon_checkout',
      actorJti:'currency-old-capture',actorTokenVersion:0,actorExpiresAt:new Date(Date.now()+60000),requestDigest:'a'.repeat(64)}});
    const captured=await p.billingRecurringAddonCheckout.create({data:{id:'currency-old-checkout',accountId:seed.account.id,appKeyId:seed.credential.id,
      customerId:'control-customer',catalogId:'currency-addon-catalog',serviceId:'control-service',offerId:'currency-addon',offerKey:'privacy',
      orgId:'control-org',teamId:capturedSubject.teamId,requestedTeamId:capturedSubject.teamId,scope:'TEAM',scopeKey:scope.scopeKey,
      actorJti:'currency-old-capture',requestedByUserId:'control-owner',subjectFingerprint:recurringAddonSubjectFingerprint({appKeyId:seed.credential.id,
        serviceId:'control-service',offerId:'currency-addon',subject:capturedSubject,scope}),
      successUrlDigest:hash('https://control.example.test/?uoa_billing=recurring_addon_success'),
      cancelUrlDigest:hash('https://control.example.test/?uoa_billing=recurring_addon_cancel'),leaseExpiresAt:new Date(Date.now()+60000),
      billingModeTeamId:capturedSubject.teamId,billingModeRevision:seed.selection.revision,billingScopeEpoch:new Date(seed.selection.epoch)}});
    const path='/billing/v1/recurring-addons/checkout',body={product:'control',organisation_id:'control-org',team_id:capturedSubject.teamId,
      user_id:'control-owner',offer_id:'currency-addon'};
    await createRecurringAddonCheckout({request:{...capturedSubject,offerId:'currency-addon',billingContext:token(path,body)},
      actorToken:'verified',credential:seed.credential as never,endpoint:path},{prisma:p});
    expect(await p.billingRecurringAddonCheckout.findUniqueOrThrow({where:{id:captured.id}}))
      .toMatchObject({customerId:'control-customer',status:'OPEN'});
    expect(vi.mocked(client.customers.create)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.checkout.sessions.create).mock.calls.at(-1)?.[0]?.customer).toBe('cus_controls');
    expect(await p.billingCreditAutoTopUpConsentRevision.count()).toBe(1);
  });
  it('refuses arbitrary provider customer keys and opposite-currency captured customers',async()=>{
    const p=handle.prisma;
    await expect(p.billingStripeCustomer.create({data:{accountId:seed.account.id,orgId:'control-org',scope:'ORGANISATION',
      scopeKey:'control-org:billing:EUR:other'}})).rejects.toThrow();
    await expect(p.$transaction(async tx=>{
      const original=await tx.billingStripeCheckoutSession.findFirstOrThrow();
      await tx.billingStripeCheckoutSession.update({where:{id:original.id},data:{status:'expired'}});
      const usd=await tx.billingStripeCustomer.findUniqueOrThrow({where:{accountId_scopeKey:{accountId:seed.account.id,scopeKey:'control-org:billing:USD'}}});
      const {id:_id,createdAt:_created,updatedAt:_updated,...copy}=original;
      await tx.billingStripeCheckoutSession.create({data:{...copy,id:'wrong-currency-checkout',customerId:usd.id,status:'creating',stripeCheckoutSessionId:null}});
    })).rejects.toMatchObject({code:'P2003'});
    const service=await p.billingService.create({data:{identifier:'currency-other',name:'Other'}});
    const tariff=await p.billingTariff.create({data:{serviceId:service.id,key:'standard',version:1,name:'Standard',mode:'STANDARD',
      collectionMode:'STRIPE',markupBps:3000,currency:'EUR',monthlyAmountMinor:299n}});
    const credential=await p.billingAppKey.create({data:{serviceId:service.id,purpose:'CUSTOMER_LIFECYCLE',name:'Other',
      keyPrefix:'currency-other',secretDigest:'c'.repeat(64),actorIssuer:'https://control.example.test',actorAudience:'https://uoa.example.test',
      actorKeyId:'other',actorPublicJwk:{kty:'RSA',n:'AQAB',e:'AQAB'},checkoutReturnOrigins:['https://control.example.test']}});
    await p.billingCustomerActionIntent.create({data:{appKeyId:credential.id,serviceId:service.id,orgId:'control-org',teamId:'control-team',
      requestedByUserId:'control-owner',authorityScope:'ORGANISATION',operation:'stripe_checkout',actorJti:'currency-conflict',
      actorTokenVersion:0,actorExpiresAt:new Date(Date.now()+60000),requestDigest:'d'.repeat(64)}});
    // Different product means no scope-exclusive duplicate can mask the
    // customer-currency guard. The captured canonical customer has an OPEN USD
    // add-on from the recovery case and cannot take another EUR subscription.
    await expect(p.billingStripeCheckoutSession.create({data:{accountId:seed.account.id,customerId:'control-customer',
      appKeyId:credential.id,serviceId:service.id,tariffId:tariff.id,tariffSource:'SERVICE_DEFAULT',orgId:'control-org',
      scope:'ORGANISATION',scopeKey:'control-org',actorJti:'currency-conflict',requestedByUserId:'control-owner',
      successUrlDigest:'a'.repeat(64),cancelUrlDigest:'b'.repeat(64),leaseExpiresAt:new Date(Date.now()+60000),
      billingModeTeamId:'control-team',billingModeRevision:seed.selection.revision,billingScopeEpoch:new Date(seed.selection.epoch)}}))
      .rejects.toThrow('STRIPE_SUBSCRIPTION_CUSTOMER_CURRENCY_CONFLICT');
    expect(await p.billingStripeCheckoutSession.count()).toBe(1);
    expect(await p.billingCreditAccount.count()).toBe(1);
  });
});
