// Explicit local browser evaluation, never included in either application's CI.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { enterpriseReadiness } from '../../API/src/services/org-sso-policy.service.js';
import { validateConfigFields } from '../../API/src/services/config.service.js';
import { loadNessieBuild, nessieAppFixture, readNessieAsset, closeNessieAssetTransport } from './nessie-app.fixture.mjs';

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

const fulfillAuthorityResponse = async (route, status, sourceHeaders, body) => {
  const headers = Object.fromEntries(Object.entries(sourceHeaders)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)]));
  if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
    // Playwright intercepts only the first request of a redirect chain. Start a
    // new navigation to the application's exact returned location, retaining its
    // actual browser cookies without sending the next hop to the public host.
    const target = JSON.stringify(headers.location).replaceAll('<', '\\u003c');
    delete headers.location; delete headers['content-length']; delete headers['content-encoding'];
    delete headers['content-security-policy']; delete headers['content-type'];
    return route.fulfill({ status: 200, headers, contentType: 'text/html',
      body: `<!doctype html><script>location.replace(${target})</script>` });
  }
  return route.fulfill({ status, headers, body });
};

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
    NAV_E2E_SERVER_LOGS: '1', NESSIE_API_PORT: '6434', NESSIE_ADMIN_PORT: '6435' });
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
  expect((await enterpriseReadiness(domain, db.prisma, org.id)).activation_allowed).toBe(true);
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
  const servers = await loadNessieBuild(checkout, 'admin/e2e/navigation/lib/servers.mjs');
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
  if (adminServer) {
    await writeFile(`${output}/vite.log`, adminServer.output());
    await stopAdmin(adminServer);
  }
  closeNessieAssetTransport();
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
    await context.routeWebSocket('**', socket => socket.close());
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && errors.length < 12) errors.push(message.text().replace(/(?:https?|wss?):\/\/[^ )']+/g, '[URL]')); });
    const assetResults = [];
    let exchange;
    let loginBody;
    let loginSlot;
    const stages = [];
    const assets = new Set();
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin === origin) {
      const response = await uoa.inject({ method: request.method(), url: url.pathname + url.search,
        headers: await request.allHeaders(), payload: request.postData() ?? undefined });
      stages.push(`uoa:${url.pathname}:${response.statusCode}`);
      return fulfillAuthorityResponse(route, response.statusCode, response.headers, response.rawPayload);
      }
      if (url.origin === provider.issuer) {
      const response = await provider.wire(route.request().url());
      stages.push(`idp:${url.pathname}:${response.status}`);
      return fulfillAuthorityResponse(route, response.status, response.headers, response.body);
      }
      if (url.origin !== productOrigin) throw new Error(`Unexpected browser destination: ${url.origin}`);
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/brand') return route.fulfill({ json: { data: { name: 'Nessie' } } });
        if (url.pathname === '/api/auth/session') {
          loginBody = request.postDataJSON();
          loginSlot = (await request.allHeaders())['x-nessie-account-slot'];
          const wrong = await nessie.app.inject({ method: 'POST', url: url.pathname,
            payload: { ...loginBody, codeVerifier: 'wrong-verifier-'.repeat(4) } });
          expect(wrong.statusCode).toBe(401);
        }
        const response = await nessie.app.inject({ method: request.method(), url: url.pathname + url.search,
          headers: await request.allHeaders(), payload: request.postData() ?? undefined });
        stages.push(`nessie:${url.pathname}:${response.statusCode}`);
        if (url.pathname === '/api/auth/session') exchange = response;
        return fulfillAuthorityResponse(route, response.statusCode, response.headers, response.rawPayload);
      }
      assets.add(url.pathname);
      try {
        const response = await readNessieAsset(`http://127.0.0.1:6435${url.pathname}${url.search}`);
        assetResults.push(`${url.pathname}:${response.status}:${response.headers['content-type']}`);
        const headers = Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]));
        delete headers['content-length']; delete headers['content-encoding'];
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch (error) {
        if (errors.length < 18) errors.push(`asset ${url.pathname}: ${error.message}; ${error.cause?.code ?? ''}`);
        if (!page.isClosed()) await route.fulfill({ status: 503, body: 'Local fixture transport unavailable' }).catch(() => {});
      } finally { assets.delete(url.pathname); }
    });
    await page.goto(`${origin}/sso/${connectionId}/start`, { waitUntil: 'commit' }).catch(error => {
      throw new Error(`Browser entry failed after ${stages.join(', ') || 'no intercepted request'}; ${adminServer.output().slice(-2000)}`, { cause: error });
    });
    await page.getByRole('button', { name: 'Continue with UnlikeOtherAI', exact: true }).waitFor({ timeout: 60000 }).catch(async error => {
      await page.screenshot({ path: `${output}/${width}-entry-failed.png` });
      const current = new URL(page.url());
      const text = await page.locator('body').innerText();
      const scripts = await page.locator('script').evaluateAll(nodes => nodes.map(node => node.src ? new URL(node.src).pathname : 'inline'));
      errors.push(`assets: ${assetResults.length}; first: ${assetResults.slice(0, 10).join(', ')}; last: ${assetResults.slice(-8).join(', ')}; scripts: ${scripts.join(', ')}`);
      throw new Error(`Login did not render at ${current.origin}${current.pathname}: ${stages.join(', ')}; ${errors.join('; ')}; pending assets ${assets.size}: ${[...assets].slice(0, 6).join(', ')}; ${text.slice(0, 1200)}`, { cause: error });
    });
    await page.screenshot({ path: `${output}/${width}-login.png` });
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session');
    await page.getByRole('button', { name: 'Continue with UnlikeOtherAI', exact: true }).click();
    await received.catch(async error => {
      await page.screenshot({ path: `${output}/${width}-exchange-failed.png` });
      const current = new URL(page.url());
      throw new Error(`Session exchange missing at ${current.origin}${current.pathname}: ${stages.join(', ')}; ${errors.slice(0, 8).join('; ')}; ${(await page.locator('body').innerText()).slice(0, 900)}`, { cause: error });
    });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const originalUserId = exchange.json().data.me.user.id;
    await page.waitForURL(url => url.origin === productOrigin && url.pathname === '/channels', { timeout: 30000 }).catch(async error => {
      await page.screenshot({ path: `${output}/${width}-handoff-failed.png` });
      const current = new URL(page.url());
      throw new Error(`Browser handoff stopped at ${current.origin}${current.pathname}: ${stages.join(', ')}; ${(await page.locator('body').innerText()).slice(0, 1000)}`, { cause: error });
    });
    await page.waitForFunction(() => Boolean(globalThis.localStorage.getItem('nessie.admin.token'))
      && !globalThis.sessionStorage.getItem('nessie.pendingExternalAuth'));
    const cookiesBefore = (await context.cookies(`${productOrigin}/api/auth/refresh`)).filter(cookie => cookie.httpOnly).map(cookie => cookie.value);
    expect(cookiesBefore.length > 0).toBe(true);
    const refreshed = await page.evaluate(async slot => {
      const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', ...(slot ? { 'x-nessie-account-slot': slot } : {}) }, body: '{}' });
      return { status: response.status, payload: await response.json() };
    }, loginSlot);
    expect(refreshed.status, `Refresh refused: ${refreshed.payload.error?.code ?? 'unknown'}`).toBe(200);
    expect(typeof refreshed.payload.data?.token).toBe('string');
    const result = refreshed.payload.data;
    expect(result.me.user.id).toBe(originalUserId);
    const cookiesAfter = (await context.cookies(`${productOrigin}/api/auth/refresh`)).filter(cookie => cookie.httpOnly);
    expect(cookiesAfter.some(cookie => !cookiesBefore.includes(cookie.value))).toBe(true);
    const me = await nessie.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${result.token}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(result.me.user.id);
    expect(await nessie.prisma.organizationMember.count({ where: { userId: result.me.user.id } })).toBe(0);
    expect(await nessie.prisma.teamMember.count({ where: { userId: result.me.user.id } })).toBe(0);
    const principal = await nessie.prisma.user.findUniqueOrThrow({ where: { id: result.me.user.id } });
    expect(principal.uoaSub).toBe(member.id); expect(principal.email).toBeNull(); expect(principal.displayName).toBeNull();
    if (width === 390) {
      // Existing-install migration fixture: stale copies must neither authorize
      // this person nor survive the explicitly reviewed cleanup.
      const organizationId = result.me.context.organizationId;
      const teamId = result.me.context.teamId;
      await nessie.prisma.user.update({ where: { id: principal.id },
        data: { email: 'stale-copy@example.com', displayName: 'Stale copy' } });
      await nessie.prisma.organizationMember.create({ data: { organizationId, userId: principal.id, role: 'owner' } });
      await nessie.prisma.teamMember.create({ data: { teamId, userId: principal.id, role: 'admin' } });
      const cleanup = await loadNessieBuild(process.env.NESSIE_CHECKOUT, 'scripts/uoa-authority-cutover.mjs');
      const scope = { organizationIds: [organizationId] };
      const report = await cleanup.inventoryUoaAuthority(nessie.prisma, scope);
      expect(report.conflicts).toEqual([]);
      await cleanup.applyUoaAuthorityCutover(nessie.prisma, scope, report.digest);
      const cleaned = await nessie.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${result.token}` } });
      expect(cleaned.statusCode, cleaned.body).toBe(200);
      expect(cleaned.json().data.user.roleIds).toEqual(['member']);
      expect(await nessie.prisma.organizationMember.count({ where: { userId: principal.id } })).toBe(0);
      expect(await nessie.prisma.teamMember.count({ where: { userId: principal.id } })).toBe(0);
    }
    const replay = await nessie.app.inject({ method: 'POST', url: '/api/auth/session', payload: loginBody });
    expect(replay.statusCode).toBe(401);
    await page.screenshot({ path: `${output}/${width}-signed-in.png`, animations: 'disabled' });
    await context.close();
    if (width === 1280) {
      await removeOrganisationMember({ domain, orgId: org.id, userId: member.id, config,
        actor: { via: 'domain_backend', sourceDomain: domain } }, { prisma: db.prisma });
      const removed = await nessie.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${result.token}` } });
      expect([401, 403]).toContain(removed.statusCode);
    }
  }
}, 300000);
