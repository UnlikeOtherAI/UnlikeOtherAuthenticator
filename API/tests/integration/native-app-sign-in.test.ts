import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, decodeJwt } from 'jose';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { saveNativeApp, setNativeAppIcon } from '../../src/services/oauth/native-app.service.js';
import { getOAuthClient } from '../../src/services/oauth/client.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { signSocialState } from '../../src/services/social/social-state.service.js';
import { isPublicSocialState } from '../../src/services/oauth/social-ticket.service.js';

const google = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/social/google.service.js', async () => ({
  ...await vi.importActual<typeof import('../../src/services/social/google.service.js')>('../../src/services/social/google.service.js'),
  getGoogleProfileFromCode: google,
}));
const issuer = 'https://auth.example.com';
const redirect = 'com.unlikeotherai.kelpie://oauth/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const scopes = 'openid profile email settings.read settings.write';
const policy = { name: 'Kelpie', enabled: true, redirect_uris: [redirect, 'http://127.0.0.1/oauth/callback'],
  scopes: scopes.split(' '), methods: ['google', 'email_password'], allow_registration: true,
  primary_color: '#1673ff', background_color: '#f8fafc', text_color: '#111827' };

describe.skipIf(!process.env.DATABASE_URL)('admin-managed native sign-in', () => {
  const previous = { ...process.env };
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let registered: Awaited<ReturnType<typeof saveNativeApp>>;
  let clientId: string;
  let token: string;
  let continuationCookies: Record<string, string>;
  let code: string;
  let flowId: string;
  beforeAll(async () => {
    handle = (await createTestDb())!;
    Object.assign(process.env, { DATABASE_URL: handle.databaseUrl, DATABASE_ADMIN_URL: handle.databaseUrl,
      MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true', MCP_OAUTH_DOMAIN: 'native.example.com', PUBLIC_BASE_URL: issuer,
      GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret' });
    const { privateKey } = await generateKeyPair('RS256');
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'native-app-test' });
    resetAccessTokenKeyCache();
    google.mockResolvedValue({ provider: 'google', email: 'app-user@example.com', emailVerified: true, name: 'App User', avatarUrl: null });
    registered = await saveNativeApp({ ...policy, identifier: 'com.unlikeotherai.kelpie' }, 'operator@example.com');
    app = await createApp(); await app.ready();
  });
  afterAll(async () => { await app?.close(); await handle?.cleanup(); process.env = previous; resetAccessTokenKeyCache(); });
  const register = (extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/oauth/register', payload: {
    app_id: 'com.unlikeotherai.kelpie', redirect_uris: [redirect], scope: scopes, ...extra,
  } });
  const context = () => new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state: 'app-state', scope: scopes,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  function cookies(response: Awaited<ReturnType<typeof app.inject>>) {
    return Object.fromEntries(response.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  }
  async function googleCallback() {
    const start = await app.inject({ url: `/oauth/social/google?${context()}` });
    expect(start.statusCode, start.body).toBe(302);
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const response = await app.inject({ url: `/auth/callback/google?${new URLSearchParams({ code: 'provider-code', state })}`, cookies: cookies(start) });
    return { response, start, state };
  }
  it('protects Admin and rejects unregistered IDs, callback and scope widening', async () => {
    expect((await app.inject({ url: '/internal/admin/native-apps' })).statusCode).toBe(401);
    expect((await register({ app_id: 'com.attacker.app' })).statusCode).toBe(400);
    expect((await register({ redirect_uris: ['https://attacker.example/callback'] })).statusCode).toBe(400);
    expect((await register({ scope: 'openid admin' })).statusCode).toBe(400);
    const result = await register(); expect(result.statusCode, result.body).toBe(201); clientId = result.json().client_id;
    expect(result.json()).not.toHaveProperty('client_secret');
  });
  it('permits only the port to vary for loopback registrations', async () => {
    expect((await register({ redirect_uris: ['http://127.0.0.1:32123/oauth/callback'] })).statusCode).toBe(201);
    expect((await register({ redirect_uris: ['http://127.0.0.1:32123/other'] })).statusCode).toBe(400);
    expect((await register({ redirect_uris: ['http://localhost:32123/oauth/callback'] })).statusCode).toBe(400);
  });
  it('renders stored branding and the real public Google link; never accepts client branding', async () => {
    const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=', 'base64');
    await setNativeAppIcon(registered.id, icon, 'operator@example.com');
    await expect(setNativeAppIcon(registered.id, Buffer.from('<svg/>'), 'operator@example.com')).rejects.toThrow();
    const response = await app.inject({ url: `/oauth/authorize?${context()}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('/oauth/social/google');
    expect(response.body).toContain('/oauth/apps/com.unlikeotherai.kelpie/icon');
    expect(response.body).toContain('#1673ff');
    const image = await app.inject({ url: '/oauth/apps/com.unlikeotherai.kelpie/icon' });
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(await getOAuthClient(clientId)).not.toBeNull(); // icon is cosmetic
  });
  it('rejects missing browser binding and a confidential state in the public verifier', async () => {
    const start = await app.inject({ url: `/oauth/social/google?${context()}` });
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    expect((await app.inject({ url: `/auth/callback/google?${new URLSearchParams({ state, code: 'x' })}` })).statusCode).toBe(401);
    const confidential = await signSocialState({ provider: 'google', configUrl: 'https://example.com/config', redirectUrl: redirect,
      nonce: 'a'.repeat(43), sharedSecret: process.env.SHARED_SECRET!, audience: 'uoa:public-oauth-social', baseUrlForIssuer: issuer });
    expect(isPublicSocialState(confidential)).toBe(false);
  });
  it('creates the verified Google account, binds the Strict cookie and issues a PKCE-only code', async () => {
    const { response, state: completedFlow } = await googleCallback();
    flowId = completedFlow;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Complete sign-in');
    const cookie = response.cookies.find((c) => c.name === `__Host-uoa-${flowId}`)!;
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/', sameSite: 'Strict' });
    continuationCookies = cookies(response);
    expect((await app.inject({ method: 'POST', url: '/oauth/social/complete', cookies: continuationCookies, payload: { flow_id: flowId } })).statusCode).toBe(403);
    const completed = await app.inject({ method: 'POST', url: '/oauth/social/complete', cookies: continuationCookies, headers: { origin: issuer }, payload: { flow_id: flowId } });
    expect(completed.statusCode, completed.body).toBe(200);
    const target = new URL(completed.json().redirect_to);
    expect(target.searchParams.get('state')).toBe('app-state');
    expect(target.searchParams.has('access_token')).toBe(false);
    code = target.searchParams.get('code')!;
    const replay = await app.inject({ method: 'POST', url: '/oauth/social/complete', cookies: continuationCookies, headers: { origin: issuer }, payload: { flow_id: flowId } });
    expect(replay.statusCode).toBe(401);
  });
  it('rejects wrong verifier, redeems once, and accesses shared profile and settings', async () => {
    const exchange = (v: string) => app.inject({ method: 'POST', url: '/oauth/token', payload: { code, client_id: clientId, redirect_uri: redirect, code_verifier: v } });
    expect((await exchange('z'.repeat(43))).statusCode).toBe(401);
    const response = await exchange(verifier); expect(response.statusCode, response.body).toBe(200);
    token = response.json().access_token;
    expect(decodeJwt(token).role).toBe('user');
    expect((await exchange(verifier)).statusCode).toBe(401);
    const me = await app.inject({ url: '/oauth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode, me.body).toBe(200); expect(me.json().email).toBe('app-user@example.com');
  });
  it('preserves clients on cosmetic edits, invalidates pending flows and tokens on policy edits', async () => {
    await saveNativeApp({ ...policy, name: 'Kelpie Browser' }, 'operator@example.com', registered.id);
    expect(await getOAuthClient(clientId)).not.toBeNull();
    await saveNativeApp({ ...policy, enabled: false }, 'operator@example.com', registered.id);
    expect(await getOAuthClient(clientId)).toBeNull();
    expect((await app.inject({ url: '/oauth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const pending = await app.inject({ method: 'POST', url: '/oauth/social/complete', cookies: continuationCookies, headers: { origin: issuer }, payload: { flow_id: flowId } });
    expect([400, 401]).toContain(pending.statusCode);
    await saveNativeApp(policy, 'operator@example.com', registered.id);
    expect(await getOAuthClient(clientId)).toBeNull();
    const fresh = await register(); expect(fresh.statusCode).toBe(201); clientId = fresh.json().client_id;
  });
  it('binds simultaneous pages to their own one-use browser flow', async () => {
    const a = await googleCallback(); const b = await googleCallback();
    const swapped = await app.inject({ method: 'POST', url: '/oauth/social/complete', headers: { origin: issuer },
      cookies: cookies(a.response), payload: { flow_id: b.state } });
    expect(swapped.statusCode).toBe(401);
    const own = await app.inject({ method: 'POST', url: '/oauth/social/complete', headers: { origin: issuer },
      cookies: { ...cookies(a.response), ...cookies(b.response) }, payload: { flow_id: a.state } });
    expect(own.statusCode, own.body).toBe(200);
    expect(new URL(own.json().redirect_to).searchParams.get('state')).toBe('app-state');
    expect((await app.inject({ method: 'POST', url: '/oauth/social/complete', headers: { origin: issuer },
      cookies: cookies(a.response), payload: { flow_id: a.state } })).statusCode).toBe(401);
  });
  it('keeps long client state on the server and returns cancellation to the bound app', async () => {
    const query = context(); query.set('state', 's'.repeat(2048));
    const start = await app.inject({ url: `/oauth/social/google?${query}` });
    expect(start.statusCode).toBe(302);
    const providerURL = new URL(start.headers.location!);
    expect(providerURL.searchParams.get('prompt')).toBe('select_account');
    const state = providerURL.searchParams.get('state')!;
    expect(state.length).toBeLessThan(64);
    const cancelled = await app.inject({ url: `/auth/callback/google?${new URLSearchParams({ state, error: 'access_denied' })}`, cookies: cookies(start) });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(decodeURIComponent(cancelled.body)).toContain('error=access_denied');
  });
  it('rejects unverified Google identities without creating an account', async () => {
    google.mockResolvedValueOnce({ provider: 'google', email: 'unverified@example.com', emailVerified: false, name: null, avatarUrl: null });
    expect((await googleCallback()).response.statusCode).toBe(401);
    expect(await handle.prisma.user.findUnique({ where: { userKey: 'unverified@example.com' } })).toBeNull();
  });
  it('retains enrolled second-factor enforcement', async () => {
    await handle.prisma.user.update({ where: { userKey: 'app-user@example.com' }, data: { twoFaEnabled: true } });
    const { response, state: completedFlow } = await googleCallback();
    flowId = completedFlow; expect(response.statusCode, response.body).toBe(200);
    const completed = await app.inject({ method: 'POST', url: '/oauth/social/complete', headers: { origin: issuer }, cookies: cookies(response), payload: { flow_id: flowId } });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().twofa_required).toBe(true); expect(completed.json().redirect_to).toBeUndefined();
  });
});
