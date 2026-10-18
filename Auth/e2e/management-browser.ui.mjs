import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createApp } from '../../API/src/app.js';
import { createTestDb } from '../../API/tests/helpers/test-db.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from '../../API/tests/helpers/test-config.js';
import { hashPassword } from '../../API/src/services/password.service.js';
import { encryptTwoFaSecret } from '../../API/src/utils/twofa-secret.js';
import { validateConfigFields } from '../../API/src/services/config.service.js';
import { sealEnterpriseSecret } from '../../API/src/services/enterprise-secret.service.js';
import { fingerprintClientConfig } from '../../API/src/services/client-config-fingerprint.service.js';
import { hashAssuranceReference } from '../../API/src/services/session-assurance.service.js';
import { registerRevocationConsumer, acknowledgeRevocationConsumer, revocationReadinessProof } from '../../API/src/services/org-sso-delivery.service.js';
import { computeTotp } from '../../API/tests/helpers/totp.js';

// Deliberate test-only personal factor; never a real person's credential.
const factor = 'JBSWY3DPEHPK3PXP';
const password = 'Test-only-personal1!';
const orgId = `browser-${randomUUID()}`;
const userId = `browser-${randomUUID()}`;
const secondUserId = `browser-${randomUUID()}`;
let db;
let app;
let origin;
let browser;
let clientConfig;
const previousCustody=process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
const previousRing=process.env.ENTERPRISE_SSO_KEYRING;

beforeAll(async () => {
  process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER='local';
  process.env.ENTERPRISE_SSO_KEYRING=JSON.stringify({current:'test',keys:{test:randomBytes(32).toString('base64')}});
  const handle = await createTestDb();
  if (!handle) throw new Error('An isolated UOA PostgreSQL test database is required');
  db = handle;
  process.env.DATABASE_URL = db.databaseUrl;
  delete process.env.DATABASE_ADMIN_URL;
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:5198';
  process.env.ADMIN_AUTH_DOMAIN = 'admin.example.com';
  process.env.ADMIN_CONFIG_JWT = await signTestConfigJwt(baseClientConfigPayload({
    domain: 'admin.example.com',redirect_urls: ['http://127.0.0.1:5198/admin/auth/callback'],
    enabled_auth_methods: ['google'],allow_registration: false,
  }));
  await db.prisma.clientDomain.create({ data: { domain: 'client.example.com', label: 'Browser fixture' } });
  await db.prisma.user.create({ data: { id: userId, email: 'owner@example.com', userKey: 'owner@example.com',
    passwordHash: await hashPassword(password), twoFaEnabled: true, twoFaSecret: encryptTwoFaSecret({secret: factor,sharedSecret: process.env.SHARED_SECRET ?? ''}) } });
  await db.prisma.organisation.create({ data: { id: orgId, domain: 'client.example.com',
    name: 'Acme browser journey', slug: orgId, ownerId: userId } });
  await db.prisma.orgMember.create({ data: { orgId, userId, role: 'owner' } });
  await db.prisma.user.create({data:{id:secondUserId,name:'Sam Recovery',email:'sam@example.com',userKey:'sam@example.com',
    twoFaEnabled:true,twoFaSecret:encryptTwoFaSecret({secret:factor,sharedSecret:process.env.SHARED_SECRET??''})}});
  await db.prisma.orgMember.create({data:{orgId,userId:secondUserId,role:'member'}});
  const team = await db.prisma.team.create({ data: { orgId, name: 'Only team', slug: 'only-team' } });
  await db.prisma.teamMember.create({ data: { teamId: team.id, userId, teamRole: 'owner' } });
  const payload=baseClientConfigPayload({'2fa_enabled':false,login_flow:{team_selection:'auto'}});
  clientConfig=validateConfigFields(payload);
  const jwt=await signTestConfigJwt(payload);
  vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  app = await createApp();
  app.addHook('onError',async(request,_reply,error)=>{
    const path=new URL(request.url,'http://fixture.invalid').pathname;
    const summary=/^[A-Z][A-Z0-9_]*$/.test(error.message)?error.message:error.name;
    console.error('Fixture route refused',path,summary);
  });
  origin = await app.listen({ host: '127.0.0.1', port: 5198 });
  const playwright = await import(/* @vite-ignore */ pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '').href);
  browser = await playwright.chromium.launch({ headless: true });
  await mkdir('e2e/artifacts/management-browser', { recursive: true });
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await db?.cleanup();
  vi.unstubAllGlobals();
  if(previousCustody===undefined)delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER=previousCustody;
  if(previousRing===undefined)delete process.env.ENTERPRISE_SSO_KEYRING;else process.env.ENTERPRISE_SSO_KEYRING=previousRing;
});

async function freshCode() {
  const user=await db.prisma.user.findUniqueOrThrow({where:{id:userId},select:{twoFaLastAcceptedCounter:true}});
  const wait=user.twoFaLastAcceptedCounter===null?0:(user.twoFaLastAcceptedCounter+1)*30000-Date.now()+100;
  if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
  return computeTotp({secret:factor,nowMs:Date.now()});
}

it('keeps a one-team owner in management and completes personal TOTP into browser-bound settings', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const query = new URLSearchParams({ config_url: 'https://client.example.com/auth-config',
    flow: 'organisation_management', management_org_id: orgId, code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256', state: 'b'.repeat(43) });
  await page.goto(`${origin}/auth?${query}`);
  await page.locator('input[name=email]').fill('owner@example.com');
  await page.locator('input[name=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await expect.poll(() => page.getByText('Acme browser journey', { exact: false }).count()).toBe(1);
  expect(await page.getByText('Only team', { exact: true }).count()).toBe(0);
  await page.screenshot({ path: 'e2e/artifacts/management-browser/390-owner-choice.png', fullPage: true });
  const responsePromise = page.waitForResponse((response) => response.url().includes('/organisation-access/start'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const start = await responsePromise;
  expect(start.status()).toBe(200);
  expect((await start.json()).twofa_required).toBe(true);
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === 'uoa_management_intent' && cookie.httpOnly)).toBe(true);
  await page.locator('input[name=code]').fill(await freshCode());
  const documentPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/organisation-access').catch(()=>null);
  const exchangeRequestPromise = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/organisation-access/exchange').catch(()=>null);
  const exchangePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/organisation-access/exchange').catch(()=>null);
  const verifyPromise = page.waitForResponse(response => response.url().includes('/2fa/verify'));
  await page.locator('button[type=submit]').click();
  const verified = await verifyPromise;
  if(verified.status()!==200){const failure=await verified.json();throw new Error('Personal factor HTTP '+verified.status()+' code '+String(failure.code));}
  await page.waitForURL('**/auth/organisation-access**');
  expect((await documentPromise).status()).toBe(200);
  expect((await exchangePromise).status()).toBe(200);
  await page.screenshot({path:'e2e/artifacts/management-browser/390-arrival.png',fullPage:true});
  await expect.poll(() => page.getByText('Acme browser journey', { exact: false }).count()).toBeGreaterThan(0);
  expect(new URL(page.url()).hash).toBe('');
  const foreign = await browser.newContext();
  const denied = await foreign.request.post(`${origin}/auth/organisation-access/exchange`, {
    data: (await exchangeRequestPromise).postDataJSON(),headers: {origin},
  });
  expect(denied.status()).toBe(403);
  await foreign.close();
  await page.reload();
  await expect.poll(() => page.getByText('Acme browser journey', {exact:false}).count()).toBeGreaterThan(0);
  expect(await db.prisma.authorizationCode.count({ where: { userId } })).toBe(0);
  expect(await db.prisma.refreshToken.count({ where: { userId } })).toBe(0);
  await page.screenshot({ path: 'e2e/artifacts/management-browser/390-settings.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'e2e/artifacts/management-browser/1280-settings.png', fullPage: true });
  await page.getByRole('button',{name:'Recovery and required sign-in',exact:true}).click();
  await expect.poll(()=>page.getByText('Sam Recovery',{exact:true}).count()).toBe(1);
  await page.screenshot({path:'e2e/artifacts/management-browser/1280-recovery-setup.png',fullPage:true});
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:'e2e/artifacts/management-browser/390-recovery-setup.png',fullPage:true});
  const boxes=page.getByRole('checkbox');await boxes.nth(0).check();await boxes.nth(1).check();
  const savedPromise=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/sso/recovery'));
  await page.getByRole('button',{name:'Save recovery contacts',exact:true}).click();
  const saved=await savedPromise;expect(saved.status()).toBe(200);
  const invitations=(await saved.json()).invitations;
  const own=invitations.find(invite=>invite.user_id===userId);expect(own).toBeTruthy();
  await page.goto(own.recovery_url);
  await page.getByRole('button',{name:'Confirm my recovery contact',exact:true}).click();
  await expect.poll(()=>page.locator('input[name=code]').count()).toBe(1);
  expect(new URL(page.url()).hash).toBe('');
  await page.screenshot({path:'e2e/artifacts/management-browser/390-recovery-code.png',fullPage:true});
  await page.locator('input[name=code]').fill(await freshCode());
  await page.getByRole('button',{name:'Verify code',exact:true}).click();
  await expect.poll(()=>page.getByText('Your recovery contact is confirmed. Complete a recovery practice next.',{exact:true}).count()).toBe(1);
  await page.getByRole('button',{name:'Practise recovery',exact:true}).click();
  await page.locator('input[name=code]').fill(await freshCode());
  await page.getByRole('button',{name:'Verify code',exact:true}).click();
  await expect.poll(()=>page.getByText('Recovery practice completed. Keep your recovery link safe.',{exact:true}).count()).toBe(1);
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'e2e/artifacts/management-browser/1280-recovery-practised.png',fullPage:true});
  expect(await db.prisma.authorizationCode.count({where:{userId}})).toBe(0);
  expect(await db.prisma.refreshToken.count({where:{userId}})).toBe(0);
  await context.close();
});

it('connects an existing account only after password or an old personal authenticator through real browser routes',async()=>{
  const domain='client.example.com';
  await db.prisma.orgSsoPolicy.upsert({where:{clientDomain_orgId:{clientDomain:domain,orgId}},
    create:{clientDomain:domain,orgId,arrangementEnabled:true},update:{arrangementEnabled:true}});
  await db.prisma.enterpriseProductReadiness.create({data:{clientDomain:domain,minimumAssuranceVersion:1,
    authorityMigrationRevision:'fixture-audited',revocationConsumersRevision:'fixture-audited'}});
  const receiver=await registerRevocationConsumer({client_domain:domain,key_id:'fixture',destination:'https://client.example.com/revocations'});
  await acknowledgeRevocationConsumer(domain,{key_id:'fixture',challenge:receiver.challenge,
    capabilities:{version:1,feed:true,reconciliation:true,use_time_assurance:true,immutable_custody:true},
    proof:revocationReadinessProof(receiver.secret,domain,'fixture',receiver.challenge)});
  const connection=await db.prisma.orgSsoConnection.create({data:{clientDomain:domain,orgId,preset:'other_oidc',protocol:'oidc',
    displayName:'Browser provider',configuration:{},status:'active',testedRevision:1}});
  for(const method of ['password','factor']) {
    const browserHandle=randomBytes(32).toString('base64url');const flowId=randomBytes(32).toString('base64url');
    const subject='browser-stable-'+method;
    const context={config_url:'https://client.example.com/auth-config',config_fingerprint:fingerprintClientConfig(clientConfig),
      client_domain:domain,redirect_url:'https://client.example.com/oauth/callback',code_challenge:'a'.repeat(43),
      code_challenge_method:'S256',state:'browser-link-state',policy_generation:1};
    await db.prisma.orgSsoFlow.create({data:{id:flowId,connectionId:connection.id,revision:1,mode:'login',
      browserHash:hashAssuranceReference(browserHandle),nonce:'fixture',encryptedVerifier:await sealEnterpriseSecret(
        randomBytes(32).toString('base64url'),'flow:'+flowId),context,consumedAt:new Date(),expiresAt:new Date(Date.now()+600000)}});
    const identity={issuer:'https://provider.example.com',tenant:'exact-tenant',subject,email:'owner@example.com',emailVerified:true,
      groups:[],authenticatedAt:null,observedAt:new Date(),sessionExpiresAt:new Date(Date.now()+3600000),amr:['provider_claim']};
    const link=await db.prisma.orgSsoLinkIntent.create({data:{connectionId:connection.id,clientDomain:domain,orgId,revision:1,generation:1,
      flowId,browserHash:hashAssuranceReference(browserHandle),context,identity:{sealed:await sealEnterpriseSecret(JSON.stringify(identity),'link:'+flowId)},
      expiresAt:new Date(Date.now()+600000)}});
    const browserContext=await browser.newContext({viewport:{width:method==='password'?390:1280,height:900}});
    await browserContext.addCookies([{name:'uoa_sso_link',value:browserHandle,url:origin+'/auth',httpOnly:true,sameSite:'Strict'}]);
    const page=await browserContext.newPage();
    await page.route('https://client.example.com/oauth/callback?*',route=>route.fulfill({contentType:'text/html',body:'Returned to product fixture'}));
    const query=new URLSearchParams({...context,flow:'enterprise_link',enterprise_link_intent:link.id});
    for(const key of ['config_fingerprint','client_domain','policy_generation'])query.delete(key);
    await page.goto(origin+'/auth?'+query);
    await page.getByRole('heading',{name:'Connect your existing UOA account',exact:true}).waitFor();
    expect(new URL(page.url()).searchParams.has('enterprise_link_intent')).toBe(false);
    if(method==='factor')await page.getByRole('button',{name:'Use my existing authenticator',exact:true}).click();
    await page.getByLabel('UOA account email',{exact:true}).fill('owner@example.com');
    if(method==='password')await page.getByLabel('UOA password',{exact:true}).fill(password);
    await page.screenshot({path:'e2e/artifacts/management-browser/'+(method==='password'?'390':'1280')+'-account-link.png',fullPage:true});
    await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.locator('input[name=code]').waitFor();
    await page.screenshot({path:'e2e/artifacts/management-browser/'+(method==='password'?'390':'1280')+'-link-authenticator.png',fullPage:true});
    await page.locator('input[name=code]').fill(await freshCode());
    const verified=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/enterprise-link/personal-factor/verify');
    await page.getByRole('button',{name:'Verify code',exact:true}).click();
    expect((await verified).status()).toBe(200);
    await page.getByText('Returned to product fixture',{exact:true}).waitFor();
    const external=await db.prisma.externalIdentity.findUniqueOrThrow({where:{connectionId_issuer_tenant_subject:{
      connectionId:connection.id,issuer:identity.issuer,tenant:identity.tenant,subject}}});
    expect(external.userId).toBe(userId);
    const issued=await db.prisma.authorizationCode.findFirstOrThrow({where:{userId},orderBy:{createdAt:'desc'}});
    const evidence=await db.prisma.authenticationEvidence.findUniqueOrThrow({where:{id:issued.authenticationEvidenceId}});
    expect(evidence.provenance).toBe('sso');expect(evidence.authenticatedAt).toBeNull();
    await browserContext.close();
  }
});
