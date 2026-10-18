// Explicit local browser evaluation, never included in either application's CI.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../../API/src/app.js';
import { createTestDb } from '../../API/tests/helpers/test-db.js';
import { seedDomainSecret } from '../../API/tests/helpers/domain-secret.js';
import { localEnterpriseOidcProvider } from '../../API/tests/helpers/enterprise-oidc-provider.js';
import { createEnterpriseSpKey } from '../../API/src/services/org-sso-sp-key.service.js';
import { openEnterpriseSecret, sealEnterpriseSecret } from '../../API/src/services/enterprise-secret.service.js';
import { resolveEnterpriseConfiguration } from '../../API/src/services/org-sso-configuration.service.js';
import { registerRevocationConsumer, acknowledgeRevocationConsumer, revocationReadinessProof } from '../../API/src/services/org-sso-delivery.service.js';
import { removeOrganisationMember } from '../../API/src/services/organisation.service.members.js';
import { validateConfigFields } from '../../API/src/services/config.service.js';
import { nessieAppFixture } from './nessie-app.fixture.mjs';

const providerTransport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../API/src/services/enterprise-http.service.js', () => ({ enterpriseFetch: providerTransport.fetch }));
const origin = 'https://authentication.unlikeotherai.com';
const productOrigin = 'https://app.example.com';
const domain = 'client.example.com';
const configUrl = `https://${domain}/api/auth/sso/config`;
const connectionId = randomUUID();
const previousEnv = { ...process.env };
let db, uoa, nessie, provider, browser, adminServer, stopAdmin, nativeFetch;
let org, team, member, config;
const output = 'e2e/artifacts/nessie-sso';

beforeAll(async () => {
  const checkout = process.env.NESSIE_CHECKOUT;
  const databaseUrl = process.env.NESSIE_DATABASE_URL;
  if (!checkout || !databaseUrl) throw new Error('Explicit Nessie checkout and isolated database are required');
  nativeFetch = globalThis.fetch;
  db = await createTestDb();
  if (!db) throw new Error('An isolated UOA PostgreSQL test database is required');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const secret = randomBytes(32).toString('base64url');
  Object.assign(process.env, { DATABASE_URL: db.databaseUrl, DATABASE_ADMIN_URL: db.databaseUrl,
    PUBLIC_BASE_URL: origin, ENTERPRISE_SSO_CUSTODY_PROVIDER: 'local',
    ENTERPRISE_SSO_KEYRING: JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } }),
    UOA_BASE_URL: origin, UOA_DOMAIN: domain, UOA_CONFIG_URL: configUrl,
    UOA_JWKS_URL: `https://${domain}/.well-known/jwks.json`, UOA_REDIRECT_URL: `${productOrigin}/login`,
    UOA_CLIENT_SECRET: secret, UOA_CONFIG_JWT_KID: `nessie-cross-${randomUUID()}`,
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKeyPem).toString('base64'),
    UOA_BILLING_APP_KEY_NESSIE: `uoa_app_${randomBytes(24).toString('base64url')}`,
    NESSIE_API_PUBLIC_URL: 'https://api.example.com',
    UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE: JSON.stringify({ ...key.privateKey.export({ format: 'jwk' }), kid: 'test-billing' }),
    NESSIE_API_PORT: '6434', NESSIE_ADMIN_PORT: '6435' });
  const transport = async (url, init = {}) => {
    // Ordinary product billing is outside enterprise enablement and is a separate fixture here.
    if (url.origin === origin && url.pathname === '/billing/v1/service-access/confirm') {
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    if (url.origin !== origin) throw new Error('Unexpected Nessie HTTP destination');
    const response = await uoa.inject({ method: init.method ?? 'GET', url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers)), payload: init.body });
    return new Response(response.rawPayload, { status: response.statusCode, headers: response.headers });
  };
  nessie = await nessieAppFixture(checkout, databaseUrl, transport);
  const jwt = nessie.auth.buildConfigJwt(nessie.auth.loadUoaSettings());
  const publicJwk = nessie.auth.buildPublicJwks(nessie.auth.loadUoaSettings()).keys[0];
  config = validateConfigFields(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')));
  vi.stubGlobal('fetch', async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === configUrl) return new Response(jwt);
    if (url.href === process.env.UOA_JWKS_URL) return Response.json({ keys: [publicJwk] });
    throw new Error('Unexpected UOA HTTP destination');
  });
  await seedDomainSecret(db.prisma, domain, secret);
  const client = await db.prisma.clientDomain.findUniqueOrThrow({ where: { domain } });
  await db.prisma.clientDomainJwk.create({ data: { domainId: client.id, kid: publicJwk.kid, jwk: publicJwk,
    fingerprint: createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex') } });
  const owner = await db.prisma.user.create({ data: { userKey: randomUUID(), email: 'owner@corporate.example.com' } });
  member = await db.prisma.user.create({ data: { userKey: randomUUID(), email: 'person@corporate.example.com' } });
  org = await db.prisma.organisation.create({ data: { domain, ownerId: owner.id, name: 'SSO journey', slug: randomUUID() } });
  team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Research', slug: 'research' } });
  await db.prisma.orgMember.createMany({ data: [{ orgId: org.id, userId: owner.id, role: 'owner' },
    { orgId: org.id, userId: member.id, role: 'member' }] });
  await db.prisma.teamMember.create({ data: { teamId: team.id, userId: member.id, teamRole: 'member' } });
  await db.prisma.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: org.id, arrangementEnabled: true } });
  await db.prisma.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1,
    authorityMigrationRevision: 'local-integration-fixture', revocationConsumersRevision: 'local-integration-fixture',
    loginEntryUrl: `${productOrigin}/login`, configUrl } });
  const registration = await registerRevocationConsumer({ client_domain: domain, key_id: 'cross-app',
    destination: `https://${domain}/api/auth/uoa/revocations` });
  await acknowledgeRevocationConsumer(domain, { key_id: registration.key_id, challenge: registration.challenge,
    proof: revocationReadinessProof(registration.secret, domain, registration.key_id, registration.challenge),
    capabilities: { version: 1, feed: true, reconciliation: true, use_time_assurance: true, immutable_custody: true } });
  const tls = await createEnterpriseSpKey('browser-wire-tls');
  provider = await localEnterpriseOidcProvider(JSON.parse(await openEnterpriseSecret(tls.encryptedSecret,
    'connection:browser-wire-tls')), `${origin}/sso/oidc/${connectionId}/callback`);
  providerTransport.fetch.mockImplementation(async (url, allowed, options) => {
    if (!allowed.includes(provider.issuer)) throw new Error('Untrusted provider destination');
    const response = await provider.wire(url, options);
    if (response.status !== 200) throw new Error('Provider refused fixture request');
    return response.body;
  });
  const configuration = await resolveEnterpriseConfiguration('other_oidc', 'oidc', {
    issuer: provider.issuer, client_id: provider.clientId, tenant: { claim: 'tenant', value: 'exact-tenant' } });
  await db.prisma.orgSsoConnection.create({ data: { id: connectionId, clientDomain: domain, orgId: org.id,
    protocol: 'oidc', preset: 'other_oidc', displayName: 'Work account', status: 'active', testedRevision: 1,
    configuration, encryptedSecret: await sealEnterpriseSecret(provider.secret, `connection:${connectionId}`) } });
  await db.prisma.externalIdentity.create({ data: { connectionId, clientDomain: domain, orgId: org.id,
    userId: member.id, issuer: provider.issuer, tenant: 'exact-tenant', subject: 'stable-subject',
    identityScope: config.user_scope, linkedVia: 'independent_session' } });
  uoa = await createApp(); await uoa.ready();
  const servers = await import(pathToFileURL(resolve(checkout, 'admin/e2e/navigation/lib/servers.mjs')).href);
  // Server readiness uses its own local transport, not the authority fixture above.
  globalThis.fetch = nativeFetch;
  adminServer = await servers.startAdmin({ reuseExisting: false }); stopAdmin = servers.stopProcess;
  const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await playwright.chromium.launch({ headless: true });
  await mkdir(output, { recursive: true });
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === configUrl) return new Response(jwt);
    if (url.href === process.env.UOA_JWKS_URL) return Response.json({ keys: [publicJwk] });
    throw new Error('Unexpected UOA HTTP destination');
  };
});

afterAll(async () => {
  await browser?.close();
  if (adminServer) await stopAdmin(adminServer);
  if (nessie && org) await nessie.prisma.organization.deleteMany({ where: { externalOrgId: org.id } });
  if (nessie && member) {
    await nessie.prisma.uoaAssuranceCredential.deleteMany({ where: { subject: member.id } });
    await nessie.prisma.user.deleteMany({ where: { uoaSub: member.id } });
  }
  await nessie?.close(); await uoa?.close(); await provider?.close(); await db?.cleanup();
  vi.unstubAllGlobals(); process.env = previousEnv;
});

it('enters through the actual Nessie login and UOA tile, redeems PKCE once and enforces canonical removal', async () => {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    let exchange;
    let loginBody;
    await context.route(`${origin}/**`, async route => {
      const request = route.request(); const url = new URL(request.url());
      const response = await uoa.inject({ method: request.method(), url: url.pathname + url.search,
        headers: await request.allHeaders(), payload: request.postData() ?? undefined });
      const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)]));
      await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
    });
    await context.route(`${provider.issuer}/**`, async route => {
      const response = await provider.wire(route.request().url());
      await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
    });
    await context.route(`${productOrigin}/**`, async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/auth/refresh') return route.fulfill({ status: 401 });
        if (url.pathname === '/api/brand') return route.fulfill({ json: { data: { name: 'Nessie' } } });
        if (url.pathname === '/api/auth/session') {
          loginBody = request.postDataJSON();
          const wrong = await nessie.app.inject({ method: 'POST', url: url.pathname,
            payload: { ...loginBody, codeVerifier: 'wrong-verifier-'.repeat(4) } });
          expect(wrong.statusCode).toBe(401);
        }
        const response = await nessie.app.inject({ method: request.method(), url: url.pathname + url.search,
          headers: await request.allHeaders(), payload: request.postData() ?? undefined });
        if (url.pathname === '/api/auth/session') exchange = response;
        return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.rawPayload });
      }
      const response = await nativeFetch(`http://127.0.0.1:6435${url.pathname}${url.search}`);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(`${origin}/sso/${connectionId}/start`);
    await page.getByRole('button', { name: 'Continue with UnlikeOtherAI', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${width}-login.png` });
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session');
    await page.getByRole('button', { name: 'Continue with UnlikeOtherAI', exact: true }).click();
    await received;
    expect(exchange.statusCode, exchange.body).toBe(200);
    const result = exchange.json().data;
    const me = await nessie.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${result.token}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(result.me.user.id);
    expect(await nessie.prisma.organizationMember.count({ where: { userId: result.me.user.id } })).toBe(0);
    expect(await nessie.prisma.teamMember.count({ where: { userId: result.me.user.id } })).toBe(0);
    const principal = await nessie.prisma.user.findUniqueOrThrow({ where: { id: result.me.user.id } });
    expect(principal.uoaSub).toBe(member.id); expect(principal.email).toBeNull(); expect(principal.displayName).toBeNull();
    const replay = await nessie.app.inject({ method: 'POST', url: '/api/auth/session', payload: loginBody });
    expect(replay.statusCode).toBe(401);
    await context.close();
    if (width === 1280) {
      await removeOrganisationMember({ domain, orgId: org.id, userId: member.id, config,
        actor: { via: 'domain_backend', sourceDomain: domain } }, { prisma: db.prisma });
      const removed = await nessie.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${result.token}` } });
      expect([401, 403]).toContain(removed.statusCode);
    }
  }
}, 180000);
