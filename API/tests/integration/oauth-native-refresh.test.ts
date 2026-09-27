import { createHash } from 'node:crypto';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { saveNativeApp } from '../../src/services/oauth/native-app.service.js';
import { PUBLIC_OAUTH_REFRESH_CONFIG_URL } from '../../src/services/oauth/native-refresh.service.js';
import { issueOAuthCode } from '../../src/services/oauth/oauth-code.service.js';
import { hashPassword } from '../../src/services/password.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import { createTestDb } from '../helpers/test-db.js';

const issuer = 'https://auth.example.com';
const domain = 'native.example.com';
const resource = 'https://api.example.com';
const redirect = 'com.unlikeotherai.kelpie://oauth/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const scopes = 'openid profile email settings.read settings.write';
const policy = {
  name: 'Kelpie', enabled: true, redirect_uris: [redirect], scopes: scopes.split(' '),
  methods: ['email_password'], allow_registration: false,
  primary_color: '#1673ff', background_color: '#f8fafc', text_color: '#111827',
};
const generic = { error: 'Request failed' };

describe.skipIf(!process.env.DATABASE_URL)('public OAuth refresh tokens for native apps', () => {
  const previous = { ...process.env };
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let appId: string;
  let nativeClient: string;
  let otherNativeClient: string;
  let plainClient: string;

  beforeAll(async () => {
    handle = (await createTestDb())!;
    Object.assign(process.env, {
      DATABASE_URL: handle.databaseUrl, DATABASE_ADMIN_URL: handle.databaseUrl,
      MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true', MCP_OAUTH_DOMAIN: domain, PUBLIC_BASE_URL: issuer,
      MCP_OAUTH_RESOURCES_SUPPORTED: resource,
    });
    const { privateKey } = await generateKeyPair('RS256');
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'native-refresh-test' });
    resetAccessTokenKeyCache();
    appId = (await saveNativeApp({ ...policy, identifier: 'com.unlikeotherai.kelpie' }, 'operator@example.com')).id;
    app = await createApp();
    await app.ready();
    nativeClient = await register({ app_id: 'com.unlikeotherai.kelpie' });
    otherNativeClient = await register({ app_id: 'com.unlikeotherai.kelpie' });
    plainClient = await register({ client_name: 'Plain MCP client' });
  });
  afterAll(async () => {
    await app?.close();
    await handle?.cleanup();
    process.env = previous;
    resetAccessTokenKeyCache();
  });

  async function register(extra: Record<string, unknown>): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      redirect_uris: [redirect], scope: scopes, token_endpoint_auth_method: 'none', ...extra,
    } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().client_id;
  }
  async function createUser(email: string): Promise<string> {
    return (await handle.prisma.user.create({ data: {
      email, userKey: email, name: 'Refresh Test', passwordHash: await hashPassword('NativePassword1!'),
    } })).id;
  }
  async function codeFor(userId: string, clientId: string, extra: { scope?: string; resource?: string } = {}) {
    const { tokenVersion } = await handle.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const issued = await handle.prisma.$transaction((tx) => issueOAuthCode({
      userId, domain, oauthClientId: clientId, redirectUrl: redirect, scope: extra.scope ?? scopes,
      resource: extra.resource, codeChallenge: challenge, credentialEpoch: tokenVersion,
    }, tx));
    return issued.code;
  }
  function exchange(clientId: string, code: string) {
    return app.inject({ method: 'POST', url: '/oauth/token', payload: {
      grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier,
    } });
  }
  async function signIn(userId: string, clientId = nativeClient, extra: { scope?: string; resource?: string } = {}) {
    const response = await exchange(clientId, await codeFor(userId, clientId, extra));
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { access_token: string; refresh_token: string; refresh_token_expires_in: number };
  }
  function refresh(clientId: string, refreshToken: string, extra: Record<string, unknown> = {}) {
    return app.inject({ method: 'POST', url: '/oauth/token', payload: {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...extra,
    } });
  }
  function revoke(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/oauth/revoke', payload });
  }
  function row(refreshToken: string) {
    return handle.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(refreshToken, process.env.SHARED_SECRET!) },
    });
  }
  async function tokenVersion(userId: string): Promise<number> {
    return (await handle.prisma.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion;
  }

  it('advertises refresh and revocation, but grants refresh only to native registrations', async () => {
    const metadata = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata.revocation_endpoint).toBe(`${issuer}/oauth/revoke`);
    const native = await app.inject({ method: 'POST', url: '/oauth/register', payload: { app_id: 'com.unlikeotherai.kelpie', redirect_uris: [redirect], scope: scopes } });
    expect(native.json().grant_types).toEqual(['authorization_code', 'refresh_token']);
    const plain = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [redirect], scope: scopes } });
    expect(plain.json().grant_types).toEqual(['authorization_code']);

    const userId = await createUser('plain@example.com');
    const exchanged = await exchange(plainClient, await codeFor(userId, plainClient));
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    expect(exchanged.json()).not.toHaveProperty('refresh_token');
    expect(exchanged.json()).not.toHaveProperty('refresh_token_expires_in');
    expect(await handle.prisma.refreshToken.count({ where: { userId } })).toBe(0);
  });

  it('issues a bound family from hosted login and rotates it into a working session', async () => {
    const userId = await createUser('native@example.com');
    const query = new URLSearchParams({ client_id: nativeClient, redirect_uri: redirect, state: 's', scope: scopes,
      code_challenge: challenge, code_challenge_method: 'S256' });
    const login = await app.inject({ method: 'POST', url: `/oauth/login?${query}`, payload: { email: 'native@example.com', password: 'NativePassword1!' } });
    expect(login.statusCode, login.body).toBe(200);
    const code = new URL(login.json().redirect_to).searchParams.get('code')!;
    const initial = await exchange(nativeClient, code);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    const first = initial.json();
    expect(first).toMatchObject({ token_type: 'Bearer', refresh_token_expires_in: 30 * 24 * 60 * 60 });
    expect(first.refresh_token).toEqual(expect.any(String));
    expect(await row(first.refresh_token)).toMatchObject({
      userId, domain, clientId: nativeClient, configUrl: PUBLIC_OAUTH_REFRESH_CONFIG_URL,
      credentialEpoch: 0, oauthScope: scopes, resource: null, twoFaCompleted: false,
    });

    const rotated = await refresh(nativeClient, first.refresh_token);
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    const body = rotated.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 30 * 60, scope: scopes, refresh_token_expires_in: 30 * 24 * 60 * 60 });
    expect(body.refresh_token).not.toBe(first.refresh_token);
    expect(decodeJwt(body.access_token)).toMatchObject({
      sub: userId, aud: issuer, client_id: nativeClient, domain, scope: scopes, tv: 0, role: 'user', token_use: 'public_oauth',
    });
    const me = await app.inject({ url: '/oauth/me', headers: { authorization: `Bearer ${body.access_token}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().sub).toBe(userId);
  });

  it('returns the live successor inside the replay grace and revokes the family on later reuse', async () => {
    const userId = await createUser('replay@example.com');
    const first = await signIn(userId);
    const second = (await refresh(nativeClient, first.refresh_token)).json();
    const replay = await refresh(nativeClient, first.refresh_token);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().refresh_token).toBe(second.refresh_token);
    expect(await handle.prisma.refreshToken.count({ where: { userId } })).toBe(2);

    // Move the predecessor's rotation outside the 120 s response-loss window.
    await handle.prisma.refreshToken.update({
      where: { id: (await row(first.refresh_token)).id },
      data: { revokedAt: new Date(Date.now() - 180_000) },
    });
    const reused = await refresh(nativeClient, first.refresh_token);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual(generic);
    expect(await handle.prisma.refreshToken.count({ where: { userId, securityRevokedAt: null } })).toBe(0);
    expect(await tokenVersion(userId)).toBe(1);
    expect((await refresh(nativeClient, second.refresh_token)).statusCode).toBe(401);
  });

  it('binds a family to its exact client without consuming it on foreign presentation', async () => {
    const userId = await createUser('foreign@example.com');
    const first = await signIn(userId);
    for (const clientId of [otherNativeClient, plainClient, 'mcp_unknown']) {
      const foreign = await refresh(clientId, first.refresh_token);
      expect(foreign.statusCode).toBe(401);
      expect(foreign.json()).toEqual(generic);
    }
    expect((await refresh(nativeClient, 'not-a-refresh-token')).statusCode).toBe(401);
    expect((await refresh(nativeClient, first.refresh_token)).statusCode).toBe(200);
  });

  it('never widens the granted scope or resource', async () => {
    const userId = await createUser('scope@example.com');
    const first = await signIn(userId, nativeClient, { scope: 'openid profile', resource });
    expect((await refresh(nativeClient, first.refresh_token, { scope: scopes })).statusCode).toBe(401);
    const narrowed = await refresh(nativeClient, first.refresh_token, { scope: 'openid profile' });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().scope).toBe('openid profile');
    expect(decodeJwt(narrowed.json().access_token)).toMatchObject({ scope: 'openid profile', aud: resource });

    process.env.MCP_OAUTH_RESOURCES_SUPPORTED = 'https://other.example.com';
    try {
      expect((await refresh(nativeClient, narrowed.json().refresh_token)).statusCode).toBe(401);
    } finally {
      process.env.MCP_OAUTH_RESOURCES_SUPPORTED = resource;
    }
  });

  it('ends the family after any credential-epoch change', async () => {
    const resetUser = await createUser('reset@example.com');
    const reset = await signIn(resetUser);
    await revokeAllRefreshTokensForUser(resetUser);
    expect((await refresh(nativeClient, reset.refresh_token)).statusCode).toBe(401);

    // A global logout elsewhere increments the epoch without touching this family's rows.
    const logoutUser = await createUser('logout@example.com');
    const logout = await signIn(logoutUser);
    await handle.prisma.user.update({ where: { id: logoutUser }, data: { tokenVersion: { increment: 1 } } });
    const rejected = await refresh(nativeClient, logout.refresh_token);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual(generic);
    expect((await row(logout.refresh_token)).revokedAt).toBeNull();
  });

  it('re-checks the second-factor policy on every refresh', async () => {
    const userId = await createUser('twofa@example.com');
    const first = await signIn(userId);
    await handle.prisma.clientDomain.create({ data: { domain, label: 'Native', twoFaPolicy: 'REQUIRED' } });
    try {
      expect((await refresh(nativeClient, first.refresh_token)).statusCode).toBe(401);
    } finally {
      await handle.prisma.clientDomain.delete({ where: { domain } });
    }
    expect((await refresh(nativeClient, first.refresh_token)).statusCode).toBe(200);
  });

  it('revokes only the presenting client family and always answers 200', async () => {
    const userId = await createUser('revoke@example.com');
    const first = await signIn(userId);
    for (const payload of [
      { token: first.refresh_token, client_id: otherNativeClient },
      { token: 'unknown-token', client_id: nativeClient },
      { client_id: nativeClient },
      {},
    ]) {
      const response = await revoke(payload);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(await tokenVersion(userId)).toBe(0);

    const current = (await refresh(nativeClient, first.refresh_token)).json();
    expect((await revoke({ token: current.refresh_token, client_id: nativeClient })).statusCode).toBe(200);
    expect(await tokenVersion(userId)).toBe(1);
    expect((await revoke({ token: current.refresh_token, client_id: nativeClient })).statusCode).toBe(200);
    expect(await tokenVersion(userId)).toBe(1);
    expect((await refresh(nativeClient, current.refresh_token)).statusCode).toBe(401);
  });

  it('stops refreshing once the native app is disabled or its security policy changes', async () => {
    const userId = await createUser('disabled@example.com');
    const first = await signIn(userId);
    await saveNativeApp({ ...policy, enabled: false }, 'operator@example.com', appId);
    const disabled = await refresh(nativeClient, first.refresh_token);
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual(generic);
    await saveNativeApp(policy, 'operator@example.com', appId);
    // Re-enabling bumps the revision, so earlier registrations and their families stay dead.
    expect((await refresh(nativeClient, first.refresh_token)).statusCode).toBe(401);
  });
});
