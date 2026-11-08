import { createHash,randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { hashPassword } from '../../src/services/password.service.js';
import { acknowledgeProductDeletion } from '../../src/services/entity-deletion-job.service.js';
import { assertBillingPeriodMode } from '../../src/services/billing-mode-period.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { baseClientConfigPayload,createTestConfigFetchHandler,signTestConfigJwt,TEST_SHARED_SECRET } from '../helpers/test-config.js';

const domain='client.example.com',configUrl=`https://${domain}/last-team-recovery`;
const password='Synthetic-local-recovery-1!',verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const challenge=createHash('sha256').update(verifier).digest('base64url');
// Real HTTP, password authentication, confidential exchange and database authority.
// Only the signed website configuration transport and product purge callback are synthetic.
describe.skipIf(!process.env.DATABASE_URL)('last TEAM deletion to exact-team sign-in over HTTP',()=>{
  let db:NonNullable<Awaited<ReturnType<typeof createTestDb>>>,app:Awaited<ReturnType<typeof createApp>>;
  let base:string,adminToken:string,domainBearer:string,query:string,orgId:string,teamId:string,userId:string,walletId:string;
  const actualFetch=globalThis.fetch;
  const request=(path:string,body:unknown,headers:Record<string,string>={})=>actualFetch(base+path,{method:'POST',
    headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  beforeAll(async()=>{
    db=(await createTestDb())!;if(!db)throw Error('Disposable PG required');await disconnectPrisma();
    vi.stubEnv('DATABASE_URL',db.databaseUrl);vi.stubEnv('DATABASE_ADMIN_URL',db.databaseUrl);
    vi.stubEnv('SHARED_SECRET',TEST_SHARED_SECRET);vi.stubEnv('AUTH_SERVICE_IDENTIFIER','uoa-auth-service');
    vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET','synthetic-admin-recovery-signing-key-at-least-32');
    vi.stubEnv('STRIPE_BILLING_ENABLED','false');
    domainBearer=await seedDomainSecret(db.prisma,domain,TEST_SHARED_SECRET);
    const user=await db.prisma.user.create({data:{email:'last-team-owner@example.test',userKey:'last-team-owner@example.test',passwordHash:await hashPassword(password)}});
    userId=user.id;
    await db.prisma.domainRole.createMany({data:[{userId,domain,role:'USER'},{userId,domain:getAdminAuthDomain(),role:'SUPERUSER'}]});
    const org=await db.prisma.organisation.create({data:{domain,name:'Preserved organisation',slug:'preserved-org',ownerId:userId}});orgId=org.id;
    await db.prisma.orgMember.create({data:{orgId,userId,role:'owner'}});
    const team=await db.prisma.team.create({data:{orgId,name:'Last original team',slug:'last-original',isDefault:true}});teamId=team.id;
    await db.prisma.teamMember.create({data:{teamId,userId,teamRole:'owner'}});
    const account=await db.prisma.billingStripeAccount.create({data:{stripeAccountId:'acct_LocalRecovery',livemode:false}});
    const customer=await db.prisma.billingStripeCustomer.create({data:{accountId:account.id,orgId,teamId,scope:'TEAM',scopeKey:`${orgId}:${teamId}`}});
    walletId=(await db.prisma.billingCreditAccount.create({data:{accountId:account.id,customerId:customer.id,orgId,teamId,scope:'TEAM',scopeKey:customer.scopeKey}})).id;
    const config=await signTestConfigJwt(baseClientConfigPayload({domain,allow_registration:false,
      login_flow:{email_code_enabled:false,team_selection:'auto',organization_id:orgId},
      org_features:{enabled:true,user_needs_team:true,allow_user_create_team:true,allow_user_create_org:false}}));
    const configFetch=await createTestConfigFetchHandler({[configUrl]:config});
    vi.stubGlobal('fetch',(input:Request|string|URL,init?:RequestInit)=>{
      const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
      return url.hostname==='127.0.0.1'?actualFetch(input,init):configFetch(input);
    });
    adminToken=await new SignJWT({domain:getAdminAuthDomain(),email:user.email,role:'superuser',tv:0,client_id:'owned-recovery'})
      .setProtectedHeader({alg:'HS256'}).setIssuer('uoa-auth-service').setAudience('uoa:access-token')
      .setSubject(userId).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(process.env.ADMIN_ACCESS_TOKEN_SECRET));
    app=await createApp();base=await app.listen({port:0,host:'127.0.0.1'});
    query=new URLSearchParams({config_url:configUrl,code_challenge:challenge,code_challenge_method:'S256',
      redirect_url:'https://client.example.com/oauth/callback'}).toString();
  });
  afterAll(async()=>{await app?.close();await disconnectPrisma();await db?.cleanup();vi.unstubAllGlobals();vi.unstubAllEnvs();});
  it('preserves org authority/evidence, offers explicit creation, and issues only the replacement team session',async()=>{
    const before=await db.prisma.billingCreditAccount.findUniqueOrThrow({where:{id:walletId}});
    const epoch=await db.prisma.billingOrganisationScopeCutover.findUniqueOrThrow({where:{id:1}});
    const headers={authorization:`Bearer ${adminToken}`},path=`/internal/admin/lifecycle/TEAM/${teamId}`;
    const previewResponse=await request(`${path}/deletion-preview`,{mode:'RETAIN_REFERENCE'},headers);
    expect(previewResponse.status).toBe(200);
    const preview=await previewResponse.json() as {digest:string;confirmation:string;effectiveScope:string;deletesEmptyOrganisation:boolean};
    expect(preview).toMatchObject({effectiveScope:'TEAM',deletesEmptyOrganisation:false});
    const started=await request(`${path}/delete`,{mode:'RETAIN_REFERENCE',previewDigest:preview.digest,
      confirmation:preview.confirmation,requestKey:randomUUID()},headers);
    expect(started.status).toBe(200);
    const job=await started.json() as {id:string;revision:number;participants:Array<{clientDomainId:string}>};
    // Stand in for the task-owned product's completed purge; UOA verifies and persists its exact receipt.
    for(const participant of job.participants)await acknowledgeProductDeletion({clientDomainId:participant.clientDomainId,
      jobId:job.id,revision:job.revision,outcome:'PURGED'});
    const completed=await request(`/internal/admin/lifecycle/deletion-jobs/${job.id}/retry`,{},headers);
    expect(completed.status).toBe(200);expect(await completed.json()).toMatchObject({status:'COMPLETE'});
    expect(await db.prisma.organisation.findUnique({where:{id:orgId}})).toMatchObject({lifecycleStatus:'ACTIVE',ownerId:userId});
    expect(await db.prisma.orgMember.findUnique({where:{orgId_userId:{orgId,userId}}})).toMatchObject({status:'ACTIVE',role:'owner'});
    expect(await db.prisma.team.count({where:{orgId,lifecycleStatus:'ACTIVE'}})).toBe(0);
    expect(await db.prisma.billingCreditAccount.findUnique({where:{id:walletId}})).toEqual(before);
    const login=await request(`/auth/login?${query}`,{email:'last-team-owner@example.test',password});
    expect(login.status,'password login into the preserved empty organisation').toBe(200);
    const choice=await login.json() as {login_token:string;teams:unknown[];creatable_orgs:unknown[];can_create_org:boolean};
    expect(choice).toMatchObject({teams:[],creatable_orgs:[{orgId,orgName:'Preserved organisation'}],can_create_org:false});
    expect(choice.login_token).toBeTruthy();
    expect(await db.prisma.team.count({where:{orgId,lifecycleStatus:'ACTIVE'}})).toBe(0); // No automatic replacement.
    const createBody={login_token:choice.login_token,org_id:orgId,name:'Replacement team',slug:'replacement-team',join_policy:'INVITE_ONLY'};
    const created=await request(`/auth/create-team?${query}`,createBody);expect(created.status).toBe(200);
    const result=await created.json() as {code:string};expect(result.code).toBeTruthy();
    const replacement=await db.prisma.team.findFirstOrThrow({where:{orgId,lifecycleStatus:'ACTIVE'}});
    expect(replacement.id).not.toBe(teamId);
    expect((await request(`/auth/create-team?${query}`,createBody)).status).toBe(401);
    expect(await db.prisma.team.count({where:{orgId,lifecycleStatus:'ACTIVE'}})).toBe(1);
    const token=await request(`/auth/token?config_url=${encodeURIComponent(configUrl)}`,{code:result.code,
      redirect_url:'https://client.example.com/oauth/callback',code_verifier:verifier},{authorization:`Bearer ${domainBearer}`});
    expect(token.status).toBe(200);const pair=await token.json() as {access_token:string};
    const me=await actualFetch(`${base}/org/me?domain=${domain}&config_url=${encodeURIComponent(configUrl)}`,
      {headers:{authorization:`Bearer ${domainBearer}`,'x-uoa-access-token':pair.access_token}});
    expect(me.status).toBe(200);expect(await me.json()).toMatchObject({org:{org_id:orgId,teams:[replacement.id]}});
    expect(await db.prisma.refreshToken.findFirst({where:{userId,revokedAt:null}})).toMatchObject({orgId,teamId:replacement.id});
    expect(await db.prisma.billingOrganisationScopeCutover.findUniqueOrThrow({where:{id:1}})).toEqual(epoch);
    await expect(assertBillingPeriodMode(db.prisma,{accountId:before.accountId,orgId,teamId:null,
      month:epoch.activatedAt.toISOString().slice(0,7),sourceCreatedAt:new Date('2020-01-01')}))
      .rejects.toThrow('BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED');
    expect(await db.prisma.billingCreditAccount.findUnique({where:{id:walletId}})).toEqual(before);
  });
});
