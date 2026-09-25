import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { hashPassword } from '../../src/services/password.service.js';
import { signMcpAccessToken, signConfidentialAccessToken, resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { createHmac } from 'node:crypto';

const issuer = 'https://auth.example.com';
const domain = 'native.example.com';
const redirect = 'com.unlikeotherai.kelpie://oauth/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const scope = 'openid profile settings.read settings.write';
const path = '/oauth/me/settings/browser/bookmarks';

function totp(secret: Buffer): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  return ((digest.readUInt32BE(digest[19]! & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

describe.skipIf(!process.env.DATABASE_URL)('native account PKCE and durable favourites', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let clientID: string;
  let userID: string;
  let token: string;
  const previous = { ...process.env };
  beforeAll(async () => {
    handle = (await createTestDb())!;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED = 'true';
    process.env.MCP_OAUTH_DOMAIN = domain;
    process.env.PUBLIC_BASE_URL = issuer;
    const { privateKey } = await generateKeyPair('RS256');
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'native-test' });
    resetAccessTokenKeyCache();
    const user = await handle.prisma.user.create({ data: {
      email: 'native@example.com', userKey: 'native@example.com', name: 'Native Test',
      passwordHash: await hashPassword('NativePassword1!'),
    } });
    userID = user.id;
    app = await createApp();
    await app.ready();
    const registration = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      client_name: 'Kelpie', redirect_uris: [redirect], scope, token_endpoint_auth_method: 'none',
    } });
    expect(registration.statusCode, registration.body).toBe(201);
    clientID = registration.json().client_id;
  });
  afterAll(async () => {
    await app?.close();
    await handle?.cleanup();
    process.env = previous;
    resetAccessTokenKeyCache();
  });

  function loginURL(extraScope = scope) {
    return '/oauth/login?' + new URLSearchParams({ client_id: clientID, redirect_uri: redirect,
      state: 'native-state', scope: extraScope, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  }
  const credentials = { email: 'native@example.com', password: 'NativePassword1!' };
  function headers(value = token) { return { authorization: `Bearer ${value}` }; }

  it('renders consent, completes login, redeems once and returns the authoritative profile/avatar', async () => {
    const authorize = await app.inject({ method: 'GET', url: loginURL().replace('/login?', '/authorize?') });
    expect(authorize.statusCode, authorize.body).toBe(200);
    const login = await app.inject({ method: 'POST', url: loginURL(), payload: credentials });
    expect(login.statusCode, login.body).toBe(200);
    const callback = new URL(login.json().redirect_to);
    expect(callback.searchParams.get('state')).toBe('native-state');
    const payload = { code: callback.searchParams.get('code'), client_id: clientID, redirect_uri: redirect, code_verifier: verifier };
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', payload });
    expect(exchange.statusCode, exchange.body).toBe(200);
    token = exchange.json().access_token;
    expect((await app.inject({ method: 'POST', url: '/oauth/token', payload })).statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/oauth/me', headers: headers() });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toEqual({ sub: userID, email: credentials.email, name: 'Native Test' });
    const avatar = await app.inject({ method: 'GET', url: '/oauth/me/avatar', headers: headers() });
    expect(avatar.statusCode, avatar.body).toBe(200);
    expect(avatar.headers['cache-control']).toBe('no-store');
  });

  it('persists in the shared user store and rejects stale concurrent writes and missing preconditions', async () => {
    const read = await app.inject({ method: 'GET', url: path, headers: headers() });
    expect(read.json()).toEqual({ value: null });
    const value = [{ title: 'Example', url: 'https://example.com/' }];
    const save = await app.inject({ method: 'PUT', url: path, headers: { ...headers(), 'if-match': read.headers.etag! }, payload: { value } });
    expect(save.statusCode, save.body).toBe(200);
    expect((await handle.prisma.userSetting.findUnique({ where: { userId_namespace_key: { userId: userID, namespace: 'browser', key: 'bookmarks' } } }))?.value).toEqual(value);
    const stale = await app.inject({ method: 'PUT', url: path, headers: { ...headers(), 'if-match': read.headers.etag! }, payload: { value: [] } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: path, headers: headers(), payload: { value: [] } })).statusCode).toBe(428);
  });

  it('rejects scope escalation, other token classes, wrong audience, missing epoch and cross-user reads', async () => {
    const claims = { subject: userID, email: credentials.email, domain, clientId: clientID,
      credentialEpoch: 0, role: 'user' as const, resource: issuer, issuer, ttlSeconds: 600, scope };
    expect((await app.inject({ method: 'POST', url: loginURL(scope + ' admin'), payload: credentials })).statusCode).toBe(400);
    const narrow = await signMcpAccessToken({ ...claims, scope: 'profile' });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(narrow) })).statusCode).toBe(403);
    const wrong = await signMcpAccessToken({ ...claims, resource: 'https://other.example.com' });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(wrong) })).statusCode).toBe(401);
    const missing = await signMcpAccessToken({ ...claims, credentialEpoch: undefined as never });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(missing) })).statusCode).toBe(401);
    const confidential = await signConfidentialAccessToken({ ...claims, sourceDomain: domain, product: 'kelpie' });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(confidential) })).statusCode).toBe(401);
    const other = await handle.prisma.user.create({ data: { email: 'other@example.com', userKey: 'other@example.com' } });
    const otherToken = await signMcpAccessToken({ ...claims, subject: other.id });
    expect((await app.inject({ method: 'GET', url: path + '?userId=' + userID, headers: headers(otherToken) })).json()).toEqual({ value: null });
  });

  it('honours enrolled TOTP, rejects replay and invalidates access on credential revocation', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await handle.prisma.user.update({ where: { id: userID }, data: { twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret, sharedSecret: process.env.SHARED_SECRET! }) } });
    const pending = await app.inject({ method: 'POST', url: loginURL(), payload: credentials });
    expect(pending.json()).toMatchObject({ twofa_required: true });
    const payload = { ...credentials, code: totp(Buffer.from('12345678901234567890')) };
    const completed = await app.inject({ method: 'POST', url: loginURL(), payload });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().redirect_to).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: loginURL(), payload })).statusCode).toBe(401);
    await handle.prisma.user.update({ where: { id: userID }, data: { tokenVersion: { increment: 1 } } });
    expect((await app.inject({ method: 'GET', url: '/oauth/me', headers: headers() })).statusCode).toBe(401);
  });
  it('binds required enrollment to the exact authorization request', async () => {
    await handle.prisma.clientDomain.upsert({ where: { domain }, create: { domain, label: 'Native', twoFaPolicy: 'REQUIRED' }, update: { twoFaPolicy: 'REQUIRED' } });
    await handle.prisma.user.update({ where: { id: userID }, data: { twoFaEnabled: false, twoFaSecret: null, twoFaLastAcceptedCounter: null } });
    const pending = await app.inject({ method: 'POST', url: loginURL(), payload: credentials });
    expect(pending.statusCode, pending.body).toBe(200);
    const setup = pending.json();
    expect(setup.twofa_enroll_required).toBe(true);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...setup.manual_secret as string].map((character) => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
    const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
    const payload = { ...credentials, setup_token: setup.setup_token, code: totp(bytes) };
    const retargeted = await app.inject({ method: 'POST', url: loginURL().replace('native-state', 'other-state'), payload });
    expect(retargeted.statusCode).toBe(401);
    const completed = await app.inject({ method: 'POST', url: loginURL(), payload });
    expect(completed.statusCode, completed.body).toBe(200);
    const callback = new URL(completed.json().redirect_to);
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', payload: {
      code: callback.searchParams.get('code'), client_id: clientID, redirect_uri: redirect, code_verifier: verifier,
    } });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const read = await app.inject({ method: 'GET', url: path, headers: headers(exchange.json().access_token) });
    expect(read.statusCode, read.body).toBe(200);
  });

});
