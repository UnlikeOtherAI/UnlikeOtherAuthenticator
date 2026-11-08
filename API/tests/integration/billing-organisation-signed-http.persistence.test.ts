import { randomBytes,createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair,exportJWK } from 'jose';
import { beforeAll,afterAll,describe,expect,it,vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from '../helpers/test-db.js';
import { seedOrganisationHttpFixture } from '../helpers/organisation-http-fixture.js';
import { seedTeamReaderRecords } from '../helpers/team-reader-fixture.js';
import { startTeamReaderLedger } from '../helpers/team-reader-ledger-http.js';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { runAddonInvoiceRecoveryCycle } from '../../src/services/billing-addon-invoice-recovery.service.js';
import { mintBillingActionContext } from '../../src/services/billing-action-context.service.js';
import { FilesystemBillingInvoicePdfStorage,type BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('actual signed organisation HTTP + assurance',()=>{
  let db:NonNullable<Awaited<ReturnType<typeof createTestDb>>>,app:FastifyInstance,fixture:Awaited<ReturnType<typeof seedOrganisationHttpFixture>>,base:string;
  let storage:BillingInvoicePdfStorage;
  let ledger:Awaited<ReturnType<typeof startTeamReaderLedger>>;
  async function request(persona:string,path:string,body:Record<string,unknown>,options:Parameters<typeof fixture.sign>[3]={},
    authorityVersion?:string){
    const token=await fixture.sign(persona,path,body as never,options);
    return fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json','x-uoa-app-key':fixture.appKey,'x-uoa-actor':token,
      'x-uoa-billing-mode-protocol':'1.0.0','x-uoa-billing-credits-protocol':'2.3.0',
      'x-uoa-billing-presentation':'1.5.0','x-uoa-billing-locale':'en-US',
      ...(authorityVersion?{'x-uoa-billing-authority-protocol':authorityVersion}:{})},body:JSON.stringify(body)});
  }
  function subject(persona:string,teamId:string|null=fixture.personas[persona]!.teamId){return {product:'nessie',organisation_id:'control-org',
    team_id:teamId,user_id:fixture.personas[persona]!.userId};}
  beforeAll(async()=>{
    const handle=await createTestDb();if(!handle)throw Error('Disposable PG required');db=handle;
    vi.stubEnv('DATABASE_URL',db.databaseUrl);vi.stubEnv('DATABASE_ADMIN_URL',db.databaseUrl);vi.stubEnv('DATABASE_ENABLED','true');
    vi.stubEnv('STRIPE_BILLING_ENABLED','false');vi.stubEnv('BILLING_ACTOR_AUDIENCE_MODE','enforce');
    const storageRoot=await mkdtemp(join(tmpdir(),'uoa-organisation-http-'));
    storage=new FilesystemBillingInvoicePdfStorage(storageRoot);
    vi.stubEnv('BILLING_INVOICE_STORAGE_PROVIDER','filesystem');vi.stubEnv('BILLING_INVOICE_FILESYSTEM_ROOT',storageRoot);
    vi.stubEnv('ENTERPRISE_SSO_CUSTODY_PROVIDER','local');vi.stubEnv('ENTERPRISE_SSO_KEYRING',JSON.stringify({current:'http-test',keys:{'http-test':randomBytes(32).toString('base64')}}));
    for(const mode of ['LIVE','SANDBOX']){
      vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,'acct_Controls');vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_http':'rk_test_http');
      vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,`whsec_http_${mode}`);
    }
    const keys=await generateKeyPair('RS256'),kid='uoa-http-access';
    vi.stubEnv('USER_ACCESS_TOKEN_PRIVATE_JWK',JSON.stringify({...await exportJWK(keys.privateKey),kid,alg:'RS256',use:'sig'}));
    vi.stubEnv('USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON',JSON.stringify({keys:[{...await exportJWK(keys.publicKey),kid,alg:'RS256',use:'sig'}]}));
    app=await createApp();base=await app.listen({port:0,host:'127.0.0.1'});
    vi.stubEnv('PUBLIC_BASE_URL',base);vi.stubEnv('AUTH_SERVICE_IDENTIFIER',new URL(base).host);
    fixture=await seedOrganisationHttpFixture(db.prisma,{publicBaseUrl:base,storage});
    await seedTeamReaderRecords(db.prisma);
    ledger=await startTeamReaderLedger(db.prisma,base);
    for(const [name,value] of Object.entries(ledger.env))vi.stubEnv(name,value);
    vi.stubEnv('CONFIG_JWKS_URL',fixture.jwksUrl);
    // Only partner config/JWKS transport is synthetic. Both JWT signatures and
    // all current UOA identity/custody/authority checks run through real routes.
    const actualFetch=globalThis.fetch;
    vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url===fixture.configUrl)return Promise.resolve(new Response(fixture.configJwt));
      if(url===fixture.jwksUrl)return Promise.resolve(Response.json({keys:[fixture.actorPublicJwk]}));
      if(ledger.matches(url))return ledger.fetch(url,init);
      return actualFetch(input,init);
    });
  });
  afterAll(async()=>{await app?.close();await ledger?.close();await disconnectPrisma();await db?.cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();});
  it('validates original assurance through the actual confidential HTTP endpoint and same-host synthetic JWKS',async()=>{
    const p=fixture.personas.ownerA!,url=`${base}/org/assurance/validate?${new URLSearchParams({domain:fixture.domain,config_url:fixture.configUrl})}`;
    const body={assurance_ref:p.assuranceRef,org_id:p.organisationId,team_id:p.teamId};
    for(const credential of [{'x-uoa-access-token':p.accessToken},{'x-uoa-subject-assertion':await fixture.signSubject('ownerA')}]){
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${fixture.domainBearer}`,...credential},
        body:JSON.stringify(body)});
      expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,active:true,assurance_id:p.assuranceId,client_domain:fixture.domain});
    }
    const borrowed=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${fixture.domainBearer}`,
      'x-uoa-subject-assertion':await fixture.signSubject('ownerA')},body:JSON.stringify({...body,assurance_ref:fixture.personas.memberA!.assuranceRef})});
    expect(borrowed.status).toBe(401);
  });
  it('admits fresh org owners/admins on any ACTIVE same-org team with no TeamMember and verifies null financial custody',async()=>{
    expect(await db.prisma.teamMember.count({where:{userId:{in:['control-owner','http-org-admin']}}})).toBe(0);
    for(const persona of ['ownerA','ownerB','adminA','adminB']){
      const response=await request(persona,'/billing/v1/organisation/capabilities',subject(persona));
      expect(response.status,persona).toBe(200);expect(await response.json()).toMatchObject({capabilities:{can_view_billing:true,can_manage_billing:true},
        financial_scope:{kind:'organisation',organisation_id:'control-org',mode:'live'}});
    }
    const response=await request('ownerA','/billing/v1/organisation/capabilities',subject('ownerA',null));
    expect(response.status).toBe(200);
    expect((await db.prisma.sessionAssurance.findUniqueOrThrow({where:{id:fixture.personas.ownerA!.assuranceId}})).teamId).toBe('control-team');
    expect((await fetch(`${base}/oauth/jwks.json`)).status).toBe(200);
  });
  it('denies team-only and ordinary-member Org money while preserving direct nonfinancial Ask',async()=>{
    const cap='/billing/v1/organisation/capabilities',overview='/billing/v1/organisation/overview';
    for(const persona of ['managerA','managerB']){
      const value=await request(persona,cap,subject(persona));expect(value.status).toBe(200);
      expect(await value.json()).toMatchObject({capabilities:{can_view_billing:false,can_manage_billing:false}});
      expect((await request(persona,overview,subject(persona))).status).toBe(403);
    }
    const response=await request('memberA',cap,subject('memberA'));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({capabilities:{can_view_billing:false,can_manage_billing:false}});
    expect((await request('memberA',overview,subject('memberA'))).status).toBe(403);
    expect((await request('memberA','/billing/v1/credits',subject('memberA'),{financial:false})).status).toBe(403);
    const ask=await request('memberA','/billing/v1/credits/funding-request',subject('memberA'),{financial:false});
    expect(ask.status).toBe(200);expect(await ask.json()).toMatchObject({recipient_user_ids:['control-owner','http-org-admin']});
    expect(await db.prisma.billingCreditEntry.count()).toBe(0);
  });
  it('requires the exact signature audience, subject, original custody client and current epoch',async()=>{
    const path='/billing/v1/organisation/capabilities',body=subject('ownerA');
    for(const options of [{audience:`${base}/billing/v1/organisation/overview`},{claims:{tv:1}},
      {claims:{assurance_ref:fixture.personas.memberA!.assuranceRef}},{claims:{assurance_ref:undefined}}]){
      expect((await request('ownerA',path,body,options)).status).toBe(401);
    }
    expect((await request('ownerA',path,{...body,team_id:'addon-other-team'})).status).toBe(401); // Original custody remains A.
  });
  it('negotiates own-team reader authority without exposing Org money or promoting another-team admin',async()=>{
    const path='/billing/v1/organisation/capabilities';
    for(const [persona,access] of [['ownerA','organisation_manager'],['adminB','organisation_manager'],
      ['managerA','none'],['managerB','team_reader'],['memberA','none']]){
      const response=await request(persona!,path,subject(persona!),{financial:false},'1.0.0');
      expect(response.status,persona).toBe(200);const verdict=await response.json();
      expect(verdict).toMatchObject({schema_version:2,access});
      if(access!=='organisation_manager')expect(verdict).not.toHaveProperty('financial_scope');
      if(access==='team_reader')expect(verdict).toMatchObject({team_scope:{team_id:'addon-other-team'},
        overview_request:{path:'/billing/v1/team/overview',body:subject('managerB')}});
    }
    expect((await request('managerB',path,subject('managerB'),{financial:false},'2.0.0')).status).toBe(400);
    for(const persona of ['managerA','memberA']){
      expect((await request(persona,'/billing/v1/team/overview',subject(persona),{financial:false})).status).toBe(403);
    }
    const overview=await request('managerB','/billing/v1/team/overview',subject('managerB'),{financial:false});
    expect(overview.status).toBe(200);const body=await overview.json() as {sections:Record<string,unknown>};
    expect(body).toMatchObject({team_scope:{team_id:'addon-other-team'},
      sections:{activity:{state:'confirmed',data:{recorded_calls:{quantity:'3'}}},
        recorded_credit_usage:{state:'confirmed'},retained_credits:{state:'confirmed'}}});
    const usage=body.sections.recorded_credit_usage as {data:{sources:Array<{source_ref:string;mode:string;recorded_usage:{credits:string}}>}};
    expect(usage.data.sources.map(row=>row.recorded_usage.credits).sort()).toEqual(['100','200','300']);
    expect(usage.data.sources.map(row=>row.mode).sort()).toEqual(['live','sandbox','sandbox']);
    expect(new Set(usage.data.sources.map(row=>row.source_ref)).size).toBe(3);
    const retained=body.sections.retained_credits as {data:{records:Array<{record_id:string;recorded_balance:{credits:string}}>}};
    expect(retained.data.records.map(row=>row.recorded_balance.credits).sort()).toEqual(['500','700']);
    expect(retained.data.records.map(row=>row.record_id)).not.toContain('reader-wallet-other-team');
    expect(JSON.stringify(body)).not.toContain('acct_');expect(JSON.stringify(body)).not.toContain('control-wallet');
    expect(Object.keys(body.sections).sort()).toEqual(['activity','recorded_credit_usage','retained_credits']);
    expect(body).not.toHaveProperty('financial_scope');expect(body).not.toHaveProperty('actions');
    expect((await request('managerB','/billing/v1/team/overview',{...subject('managerB'),team_id:null},{financial:false})).status).toBe(400);
    expect((await request('managerB','/billing/v1/team/overview',subject('managerB'),
      {financial:false,audience:`${base}/billing/v1/organisation/capabilities`})).status).toBe(401);
  });
  it('keeps own-team retained history and Org funding/credits independently available when metering fails',async()=>{
    ledger.fail(true);
    try{
      const team=await request('managerB','/billing/v1/team/overview',subject('managerB'),{financial:false});
      expect(team.status).toBe(200);const value=await team.json() as {sections:Record<string,unknown>};
      expect(value.sections).toMatchObject({activity:{state:'unavailable'},recorded_credit_usage:{state:'unavailable'},
        retained_credits:{state:'confirmed'}});
      const overview=await request('ownerA','/billing/v1/organisation/overview',subject('ownerA'));
      expect(overview.status).toBe(200);expect(await overview.json()).toMatchObject({sections:{
        accrued_bill:{state:'pending_reconciliation'},credits:{state:'confirmed'},funding:{state:'confirmed'},subscription:{state:'confirmed'}}});
    }finally{ledger.fail(false);}
  });
  it('refuses direct legacy and financial-only reads for team readers, including frozen mutations and SQL intents',async()=>{
    const body=subject('managerB'),month=new Date().toISOString().slice(0,7);
    for(const [path,extra] of [
      ['/billing/v1/credits',{}],['/billing/v1/customer-statement',{}],['/billing/v2/customer-statement',{}],
      ['/billing/v1/recurring-addons',{}],['/billing/v1/stripe/subscription-summary',{}],
      ['/billing/v1/credits/purchase-status',{purchase_id:'cs_unknown'}],
      ['/billing/v1/cycles/list',{}],['/billing/v1/invoices/list',{charge_month:month}],
    ] as const){
      expect((await request('managerB',path,{...body,...extra},{financial:false})).status,path).toBe(403);
    }
    const displayed=await (await request('ownerA','/billing/v1/organisation/overview',subject('ownerA'))).json() as {
      sections:{funding:{data:{automatic_top_up:{disable_action:{request:{path:string;body:Record<string,unknown>}}}}}}};
    const action=displayed.sections.funding.data.automatic_top_up.disable_action.request;
    expect((await request('managerB',action.path,{...action.body,...body})).status).toBe(403);
    await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_scope_manager('control-org','addon-other-team','http-team-manager')`)
      .rejects.toThrow('BILLING_MANAGER_REQUIRED');
    await expect(db.prisma.billingCustomerActionIntent.create({data:{appKeyId:fixture.seed.credential.id,serviceId:'control-service',
      orgId:'control-org',teamId:'addon-other-team',requestedByUserId:'http-team-manager',authorityScope:'ORGANISATION',
      operation:'stripe_portal',actorJti:'forbidden-team-manager',actorTokenVersion:0,actorExpiresAt:new Date(Date.now()+60000),
      requestDigest:'a'.repeat(64)}})).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    expect(await db.prisma.billingCreditEntry.count()).toBe(0);
  });
  it('rechecks reader authority after a role removal and preserves its session for explicit Ask',async()=>{
    const key={teamId_userId:{teamId:'addon-other-team',userId:'http-team-manager'}};
    await db.prisma.teamMember.update({where:key,data:{teamRole:'member'}});
    expect((await request('managerB','/billing/v1/team/overview',subject('managerB'),{financial:false})).status).toBe(403);
    const verdict=await request('managerB','/billing/v1/organisation/capabilities',subject('managerB'),{financial:false},'1.0.0');
    expect(await verdict.json()).toMatchObject({access:'none'});
    const ask=await request('managerB','/billing/v1/credits/funding-request',subject('managerB'),{financial:false});
    expect(ask.status).toBe(200);expect(await ask.json()).toMatchObject({recipient_user_ids:['control-owner','http-org-admin']});
    expect(await db.prisma.refreshToken.count({where:{familyId:fixture.personas.managerB!.familyId,revokedAt:null}})).toBe(1);
    await db.prisma.teamMember.update({where:key,data:{teamRole:'admin'}});
  });
  it('keeps confirmed money, saved funding controls and the plan beside the inclusive bill hold',async()=>{
    const response=await request('ownerA','/billing/v1/organisation/overview',subject('ownerA'));
    expect(response.status).toBe(200);const overview=await response.json() as {sections:Record<string,unknown>};
    expect(overview.sections.accrued_bill).toMatchObject({state:'pending_reconciliation'});
    expect(overview.sections.accrued_bill).not.toHaveProperty('data');
    expect(overview.sections.credits).toMatchObject({state:'confirmed',data:{confirmed_balance:{credits:'0'}}});
    expect(overview.sections.funding).toMatchObject({state:'confirmed',data:{funding_policy:{offers:[]},automatic_top_up:{state:'active',
      disable_action:{enabled:true}},collection:{stripe_collection_enabled:false}}});
    const plan=overview.sections.subscription as {state:string;code?:string};expect(plan.state,JSON.stringify({code:plan.code})).toBe('confirmed');
  });
  it('refuses superseded team aggregate reads for managers without financial dependencies, and denies members',async()=>{
    for(const path of ['/billing/v1/credits','/billing/v1/customer-statement','/billing/v2/customer-statement']){
      const manager=await request('ownerA',path,subject('ownerA'),{financial:false});
      expect(manager.status,path).toBe(409);expect(await manager.text()).toContain('BILLING_ORGANISATION_OVERVIEW_REQUIRED');
      expect((await request('memberA',path,subject('memberA'),{financial:false})).status,path).toBe(403);
    }
    expect((await request('ownerA','/billing/v1/organisation/capabilities',subject('ownerA'))).status).toBe(200);
  });
  it('holds incomplete invoice LIST, preserves verified DETAIL/PDF and recovers without a financial action retry',async()=>{
    const row=await db.prisma.billingStripePaymentInvoice.findFirstOrThrow(),invoiceId=`stripe:${row.id}`,
      body={...subject('ownerB'),financial_scope:'organisation',billing_mode:'live'};
    const list=await request('ownerB','/billing/v1/invoices/list',{...body,charge_month:new Date().toISOString().slice(0,7)});
    expect(list.status).toBe(409);expect(await list.text()).toContain('BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED');
    const detail=await request('ownerB','/billing/v1/invoices/detail',{...body,invoice_id:invoiceId});expect(detail.status).toBe(200);
    const document=await request('ownerB','/billing/v1/invoices/download',{...body,invoice_id:invoiceId,document_id:invoiceId});
    expect(document.status).toBe(200);const bytes=Buffer.from(await document.arrayBuffer());
    expect(bytes.subarray(0,5).toString()).toBe('%PDF-');expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.pdfSha256);
    for(let index=0;index<2;index++)expect(await runAddonInvoiceRecoveryCycle({prisma:db.prisma,
      runtime:async()=>({client:fixture.seed.stripe,livemode:true,webhookSecret:'fixture'})})).toMatchObject({completed:1,held:0});
    expect((await request('ownerB','/billing/v1/invoices/list',{...body,charge_month:new Date().toISOString().slice(0,7)})).status).toBe(200);
  });
  it('keeps strict legacy history subjects while reading the same ORG finances from either selected team',async()=>{
    const ids:string[][]=[];
    for(const persona of ['ownerA','ownerB']){
      const list=await request(persona,'/billing/v1/invoices/list',{...subject(persona),charge_month:new Date().toISOString().slice(0,7)},
        {financial:false});
      expect(list.status,persona).toBe(200);const body=await list.json() as {subject:Record<string,unknown>;invoices:Array<{invoice_id:string}>};
      expect(body.subject).toEqual(subject(persona));ids.push(body.invoices.map(row=>row.invoice_id).sort());
      const detail=await request(persona,'/billing/v1/invoices/detail',{...subject(persona),invoice_id:ids.at(-1)![0]}, {financial:false});
      expect(detail.status).toBe(200);const value=await detail.json() as {document:{download_action:{body:Record<string,unknown>}}};
      expect(value.document.download_action.body).not.toHaveProperty('financial_scope');
      expect(value.document.download_action.body.team_id).toBe(fixture.personas[persona]!.teamId);
    }
    expect(ids[0]).toHaveLength(2);expect(ids[1]).toEqual(ids[0]);
    expect((await request('memberA','/billing/v1/invoices/list',{...subject('memberA'),charge_month:new Date().toISOString().slice(0,7)},
      {financial:false})).status).toBe(403);
  });
  it('refuses missing/stale/altered original Disable contexts without ending the session, then consumes the displayed action',async()=>{
    const overview=await (await request('ownerA','/billing/v1/organisation/overview',subject('ownerA'))).json() as {
      sections:{funding:{data:{automatic_top_up:{disable_action:{request:{path:string;body:Record<string,unknown>}}}}}}};
    const action=overview.sections.funding.data.automatic_top_up.disable_action.request;
    const {billing_context:_context,...unbound}=action.body;
    expect((await request('ownerA',action.path,unbound)).status).toBe(409);
    expect((await request('ownerA',action.path,{...action.body,billing_context:String(action.body.billing_context)+'x'})).status).toBe(400);
    const stale=mintBillingActionContext({account:fixture.seed.account,revision:fixture.seed.selection.revision+1,
      scopeEpoch:fixture.seed.selection.epoch,appKeyId:fixture.seed.credential.id},action.path,action.body);
    expect((await request('ownerA',action.path,{...action.body,billing_context:stale})).status).toBe(409);
    expect((await request('ownerA','/billing/v1/organisation/capabilities',subject('ownerA'))).status).toBe(200);
    expect((await request('ownerA',action.path,action.body)).status).toBe(204);
    expect(await db.prisma.billingCreditAccount.findUniqueOrThrow({where:{id:'control-wallet'}})).toMatchObject({autoTopUpState:'DISABLED',autoTopUpConsentRevisionId:null});
    expect(await db.prisma.billingCreditAutoTopUpDisableEvent.count()).toBe(1);expect(await db.prisma.billingCreditEntry.count()).toBe(0);
    expect(await db.prisma.refreshToken.count({where:{familyId:fixture.personas.ownerA!.familyId,revokedAt:null}})).toBe(1);
  });
});
