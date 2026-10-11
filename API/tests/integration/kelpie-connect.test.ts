import { createHash } from 'node:crypto';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { saveNativeApp } from '../../src/services/oauth/native-app.service.js';
import { signMcpAccessToken, resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { hashPassword } from '../../src/services/password.service.js';

const issuer = 'https://auth.example.com';
const domain = 'native.example.com';
const resource = 'https://api.nessie.works/api/kelpie/connect';
const redirect = 'com.unlikeotherai.kelpie://oauth/callback';
const scopes = 'openid profile kelpie.connect';
const appId = 'com.unlikeotherai.kelpie';
const policy = { name: 'Kelpie', enabled: true, redirect_uris: [redirect], scopes: scopes.split(' '),
  methods: ['email_password'], allow_registration: false, primary_color: '#1673ff',
  background_color: '#ffffff', text_color: '#111827' };

describe.skipIf(!process.env.DATABASE_URL)('Kelpie connection authority', () => {
  const previous = { ...process.env };
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let registeredId: string; let clientId: string; let userId: string;
  let domainBearer: string; let foreignBearer: string; let accountToken: string;
  let privateKey: KeyLike;
  beforeAll(async () => {
    handle = (await createTestDb())!;
    Object.assign(process.env, { DATABASE_URL: handle.databaseUrl, DATABASE_ADMIN_URL: handle.databaseUrl,
      MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true', MCP_OAUTH_DOMAIN: domain, PUBLIC_BASE_URL: issuer,
      KELPIE_CONNECT_RESOURCE: resource, DEBUG_ENABLED: 'true' });
    delete process.env.MCP_OAUTH_SCOPES_SUPPORTED;
    privateKey = (await generateKeyPair('RS256')).privateKey;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'kelpie-test' });
    resetAccessTokenKeyCache();
    const user = await handle.prisma.user.create({ data: { email: 'kelpie@example.com', userKey: 'kelpie@example.com',
      passwordHash: await hashPassword('KelpiePassword1!') } });
    userId = user.id;
    registeredId = (await saveNativeApp({ ...policy, identifier: appId }, 'operator@example.com')).id;
    domainBearer = (await createAdminDomain({ domain: 'api.nessie.works', actorEmail: 'operator@example.com' })).clientHash;
    foreignBearer = (await createAdminDomain({ domain: 'other.example.com', actorEmail: 'operator@example.com' })).clientHash;
    await handle.prisma.clientDomain.create({ data: { domain, label: 'Native' } });
    app = await createApp(); await app.ready();
  });
  afterAll(async () => {
    await app?.close(); await handle?.cleanup(); process.env = previous; resetAccessTokenKeyCache();
  });
  beforeEach(async () => {
    process.env.KELPIE_CONNECT_RESOURCE = resource;
    process.env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED = 'true';
    delete process.env.MCP_OAUTH_SCOPES_SUPPORTED;
    await handle.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 0, twoFaEnabled: false, lifecycleStatus: 'ACTIVE' } });
    await handle.prisma.clientDomain.update({ where: { domain }, data: { status: 'active', twoFaPolicy: 'OPTIONAL', allowedEmails: [] } });
    await handle.prisma.ban.deleteMany({ where: { domain } });
    await handle.prisma.domainRole.updateMany({ where: { domain, userId }, data: { role: 'USER' } });
    await saveNativeApp(policy, 'operator@example.com', registeredId);
    const registered = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      app_id: appId, redirect_uris: [redirect], scope: scopes,
    } });
    expect(registered.statusCode, registered.body).toBe(201); clientId = registered.json().client_id;
    accountToken = await token();
  });
  function token(extra: Record<string, unknown> = {}) {
    return signMcpAccessToken({ subject: userId, email: 'kelpie@example.com', domain, clientId,
      credentialEpoch: 0, role: 'user', resource: issuer, issuer, ttlSeconds: 600, scope: scopes, ...extra });
  }
  function issue(value = accountToken, requested = resource) {
    return app.inject({ method: 'POST', url: '/oauth/kelpie/connect', headers: { authorization: `Bearer ${value}` }, payload: { resource: requested } });
  }
  function validate(ticket: string, caller = 'api.nessie.works', bearer = domainBearer) {
    return app.inject({ method: 'POST', url: '/oauth/kelpie/connect/validate?domain=' + caller,
      headers: { authorization: `Bearer ${bearer}` }, payload: { ticket } });
  }
  async function ticket() {
    const result = await issue(); expect(result.statusCode, result.body).toBe(200); return result.json().connection_ticket as string;
  }
  it('keeps gateway validation independent of the native issuance rate bucket', async () => {
    const value = await ticket();
    for (let i = 0; i < 121; i += 1) {
      const result = await validate(value);
      expect(result.statusCode, result.body).toBe(200);
    }
    expect((await issue()).statusCode).toBe(200);
  }, 60000);
  it('completes PKCE and refresh without silently widening old grants; issues a profile-free live ticket', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const context = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state: 'kelpie-state', scope: scopes,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const login = await app.inject({ method: 'POST', url: '/oauth/login?' + context, payload: {
      email: 'kelpie@example.com', password: 'KelpiePassword1!',
    } });
    expect(login.statusCode, login.body).toBe(200);
    const code = new URL(login.json().redirect_to).searchParams.get('code');
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', payload: { code,
      client_id: clientId, redirect_uri: redirect, code_verifier: verifier } });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const grant = exchange.json();
    expect(decodeJwt(grant.access_token).scope).toBe(scopes);
    const widened = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token',
      client_id: clientId, refresh_token: grant.refresh_token, scope: scopes + ' email' } });
    expect(widened.statusCode).toBe(401);
    const refreshed = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token',
      client_id: clientId, refresh_token: grant.refresh_token } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const result = await issue(refreshed.json().access_token);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toMatchObject({ token_type: 'Bearer', expires_in: 120, gateway_url: resource.replace('https:', 'wss:') });
    const claims = decodeJwt(result.json().connection_ticket);
    expect(claims).toMatchObject({ iss: issuer, sub: userId, aud: resource, token_use: 'kelpie_connect',
      scope: 'kelpie.connect', app_id: appId, client_id: clientId, tv: 0, twofa: false });
    for (const field of ['email', 'name', 'avatar', 'domain', 'org', 'active', 'role']) expect(claims).not.toHaveProperty(field);
    const live = await validate(result.json().connection_ticket);
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json()).toEqual({ active: true, iss: issuer, sub: userId, aud: resource, client_id: clientId,
      app_id: appId, exp: claims.exp, jti: claims.jti });
    const revoked = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: {
      client_id: clientId, token: refreshed.json().refresh_token,
    } });
    expect(revoked.statusCode).toBe(200);
    expect((await validate(result.json().connection_ticket)).statusCode).toBe(401);
  });
  it('restricts dedicated scope registration and operator policy to the exact native app', async () => {
    const plain = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [redirect], scope: scopes } });
    expect(plain.statusCode).toBe(400);
    await expect(saveNativeApp({ ...policy, identifier: 'com.example.browser' }, 'operator@example.com')).rejects.toThrow();
    const narrow = await issue(await token({ scope: 'profile' }));
    expect(narrow.statusCode).toBe(403); expect(narrow.headers['cache-control']).toBe('no-store');
    expect((await issue(accountToken, 'https://other.example.com/api/kelpie/connect')).statusCode).toBe(400);
  });
  it('caps ticket expiry at the source account expiry and refuses resource tokens as account authority', async () => {
    const short = await issue(await token({ ttlSeconds: 5 }));
    expect(short.statusCode).toBe(200); expect(short.json().expires_in).toBeLessThanOrEqual(5);
    expect((await issue(await ticket())).statusCode).toBe(401);
    expect((await issue(await token({ resource }))).statusCode).toBe(401);
  });
  it('authenticates the exact gateway domain and current domain credential', async () => {
    const value = await ticket();
    expect((await validate(value, 'other.example.com', foreignBearer)).statusCode).toBe(401);
    expect((await validate(value, 'api.nessie.works', foreignBearer)).statusCode).toBe(401);
    await handle.prisma.clientDomain.update({ where: { domain: 'api.nessie.works' }, data: { status: 'disabled' } });
    expect((await validate(value)).statusCode).toBe(401);
    await handle.prisma.clientDomain.update({ where: { domain: 'api.nessie.works' }, data: { status: 'active' } });
  });
  it('rejects expired, tampered, wrong-class, wrong-app, wrong-audience and excessive-lifetime tickets', async () => {
    const value = await ticket(); const claims = decodeJwt(value);
    for (const extra of [{ token_use: 'public_oauth' }, { app_id: 'com.attacker.app' }, { aud: issuer }, { aud: [resource, issuer] },
      { tv: -1 }, { exp: claims.iat! - 1 }, { exp: claims.iat! + 121 }, { iat: claims.iat! + 600 }]) {
      const forged = await new SignJWT({ ...claims, ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'kelpie-test', typ: 'at+jwt' }).sign(privateKey);
      const result = await validate(forged);
      expect(result.statusCode).toBe(401); expect(result.headers['cache-control']).toBe('no-store');
      expect(result.json()).toEqual({ error: 'Request failed' });
    }
    expect((await validate(value.slice(0, -4) + 'aaaa')).statusCode).toBe(401);
  });
  it('rechecks current account epoch, lifecycle, factor and native app revision on live validation', async () => {
    const value = await ticket();
    for (const mutation of [{ tokenVersion: 1 }, { lifecycleStatus: 'DISABLED' as const }, { twoFaEnabled: true }]) {
      await handle.prisma.user.update({ where: { id: userId }, data: mutation });
      expect((await validate(value)).statusCode).toBe(401);
      await handle.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 0, lifecycleStatus: 'ACTIVE', twoFaEnabled: false } });
    }
    await saveNativeApp({ ...policy, enabled: false }, 'operator@example.com', registeredId);
    expect((await validate(value)).statusCode).toBe(401);
    await saveNativeApp(policy, 'operator@example.com', registeredId);
    expect((await validate(value)).statusCode).toBe(401); // Re-enable never resurrects the old registration.
  });
  it('rechecks server scope narrowing, login bans and native domain policy', async () => {
    const value = await ticket();
    process.env.MCP_OAUTH_SCOPES_SUPPORTED = 'openid,profile';
    expect((await validate(value)).statusCode).toBe(401);
    delete process.env.MCP_OAUTH_SCOPES_SUPPORTED;
    await handle.prisma.ban.create({ data: { domain, type: 'USER', value: userId } });
    expect((await validate(value)).statusCode).toBe(401);
    await handle.prisma.ban.deleteMany({ where: { domain } });
    await handle.prisma.clientDomain.update({ where: { domain }, data: { status: 'disabled' } });
    expect((await validate(value)).statusCode).toBe(401);
  });
  it('fails closed before parsing or authority reads when the operator resource or profile is absent', async () => {
    const value = await ticket();
    delete process.env.KELPIE_CONNECT_RESOURCE;
    const disabled = await issue(); expect(disabled.statusCode).toBe(404); expect(disabled.headers['cache-control']).toBe('no-store');
    expect((await validate(value)).statusCode).toBe(404);
    process.env.KELPIE_CONNECT_RESOURCE = resource; process.env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED = 'false';
    expect((await issue()).statusCode).toBe(404);
  });

  const binding = { challenge: 'c'.repeat(43), clientId: 'cli-client' };
  function pairIssue(value = accountToken) {
    return app.inject({ method: 'POST', url: '/oauth/kelpie/pair',
      headers: { authorization: `Bearer ${value}` }, payload: binding });
  }
  function pairValidate(ticket: string, value = accountToken, extra: Record<string, unknown> = {}) {
    return app.inject({ method: 'POST', url: '/oauth/kelpie/pair/validate',
      headers: { authorization: `Bearer ${value}` }, payload: { ...binding, ticket, ...extra } });
  }
  async function pairingTicket() {
    const result = await pairIssue(); expect(result.statusCode, result.body).toBe(200);
    return result.json().pairing_ticket as string;
  }
  it('issues a profile-free local proof independently of gateway configuration and validates the same live subject', async () => {
    delete process.env.KELPIE_CONNECT_RESOURCE;
    const result = await pairIssue();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toMatchObject({ token_type: 'Bearer', expires_in: 120 });
    const claims = decodeJwt(result.json().pairing_ticket);
    expect(claims).toMatchObject({ token_use: 'kelpie_pair', sub: userId,
      aud: 'urn:unlikeotherai:kelpie:pair:' + binding.challenge, challenge: binding.challenge,
      pairing_client_id: binding.clientId, app_id: appId, scope: 'kelpie.connect' });
    for (const field of ['email', 'name', 'avatar', 'domain', 'org', 'role']) expect(claims).not.toHaveProperty(field);
    const live = await pairValidate(result.json().pairing_ticket, await token({ scope: 'profile' }));
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json()).toEqual({ active: true, expires_at: claims.exp! * 1000 });
    expect(live.headers['cache-control']).toBe('no-store');
  });
  it('rejects another authorized account without invalidating the receiver session or exposing identity', async () => {
    const other = await handle.prisma.user.create({ data: { email: 'pair-other@example.com', userKey: 'pair-other@example.com' } });
    const result = await pairIssue(await token({ subject: other.id, email: other.email }));
    expect(result.statusCode, result.body).toBe(200);
    const decision = await pairValidate(result.json().pairing_ticket);
    expect(decision.statusCode).toBe(200); expect(decision.json()).toEqual({ active: false });
    expect((await pairValidate(await pairingTicket())).json().active).toBe(true);
  });
  it('rejects local proof class/audience/binding/expiry misuse with a non-signout decision', async () => {
    const value = await pairingTicket(); const claims = decodeJwt(value);
    for (const extra of [{ token_use: 'kelpie_connect' }, { token_use: 'public_oauth' }, { app_id: 'com.other.app' },
      { aud: resource }, { aud: [claims.aud] }, { challenge: 'other' }, { pairing_client_id: 'other' },
      { tv: -1 }, { exp: claims.iat! - 1 }, { exp: claims.iat! + 121 }, { iat: claims.iat! + 600 }]) {
      const forged = await new SignJWT({ ...claims, ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'kelpie-test', typ: 'at+jwt' }).sign(privateKey);
      const decision = await pairValidate(forged);
      expect(decision.statusCode, decision.body).toBe(200); expect(decision.json()).toEqual({ active: false });
      expect(decision.headers['cache-control']).toBe('no-store');
    }
    for (const invalid of [accountToken, await ticket(), value.slice(0, -4) + 'aaaa']) {
      expect((await pairValidate(invalid)).json()).toEqual({ active: false });
    }
    expect((await pairValidate(value, accountToken, { clientId: 'another-client' })).json()).toEqual({ active: false });
    expect((await pairValidate(value, accountToken, { challenge: 'd'.repeat(43) })).json()).toEqual({ active: false });
    expect((await validate(value)).statusCode).toBe(401);
    expect((await pairIssue(value)).statusCode).toBe(401);
  });
  it('caps local access at both account expiries and requires existing connection consent for issuance', async () => {
    const result = await pairIssue(await token({ ttlSeconds: 5 }));
    expect(result.statusCode).toBe(200); expect(result.json().expires_in).toBeLessThanOrEqual(5);
    const claims = decodeJwt(await token({ ttlSeconds: 3 }));
    const live = await pairValidate(await pairingTicket(), await token({ ttlSeconds: 3 }));
    expect(live.statusCode).toBe(200); expect(live.json().expires_at).toBeLessThanOrEqual((claims.exp! + 1) * 1000);
    expect((await pairIssue(await token({ scope: 'profile' }))).statusCode).toBe(403);
  });
  it('rechecks issuing client consent while keeping a healthy receiving client signed in', async () => {
    const registered = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      app_id: appId, redirect_uris: [redirect], scope: 'profile',
    } });
    expect(registered.statusCode).toBe(201);
    const receiver = await token({ clientId: registered.json().client_id, scope: 'profile' });
    const value = await pairingTicket();
    expect((await pairValidate(value, receiver)).json().active).toBe(true);
    await handle.prisma.oAuthClient.update({ where: { clientId }, data: { scopes: ['profile'] } });
    const rejected = await pairValidate(value, receiver);
    expect(rejected.statusCode, rejected.body).toBe(200); expect(rejected.json()).toEqual({ active: false });
  });
  it('reserves 401 for a receiver whose own live account authority is invalid', async () => {
    const value = await pairingTicket();
    await handle.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 1 } });
    const rejected = await pairValidate(value);
    expect(rejected.statusCode).toBe(401); expect(rejected.json()).toEqual({ error: 'Request failed' });
    const fresh = await token({ credentialEpoch: 1 });
    expect((await pairValidate(value, fresh)).json()).toEqual({ active: false });
  });
  it('publishes local pairing in both integration contracts and gates it on the public profile', async () => {
    const schema = (await app.inject('/api')).json();
    expect(schema.endpoints.some((endpoint: { path: string }) => endpoint.path === '/oauth/kelpie/pair')).toBe(true);
    expect((await app.inject('/llm')).body).toContain('/oauth/kelpie/pair/validate');
    process.env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED = 'false';
    const disabled = await pairIssue(); expect(disabled.statusCode).toBe(404);
    expect(disabled.headers['cache-control']).toBe('no-store');
  });
});
