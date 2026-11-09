import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { saveNativeApp } from '../../src/services/oauth/native-app.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import type { SocialProviderKey } from '../../src/services/social/provider.base.js';

const mocks = vi.hoisted(() => ({ profile: vi.fn(), mail: vi.fn() }));
vi.mock('../../src/services/social/provider-profile.service.js', () => ({ getSocialProfileFromCode: mocks.profile }));
vi.mock('../../src/services/email.service.js', async () => ({
  ...await vi.importActual<typeof import('../../src/services/email.service.js')>('../../src/services/email.service.js'),
  sendLoginCodeEmail: mocks.mail,
}));
const issuer = 'https://auth.example.com';
const redirect = 'com.unlikeotherai.kelpie://oauth/callback';
const verifier = 'v'.repeat(43);
const providers = ['google', 'apple', 'facebook', 'github', 'linkedin', 'x'] as const;
const policy = { name: 'Kelpie', enabled: true, redirect_uris: [redirect], scopes: ['openid', 'profile', 'email'],
  methods: [...providers, 'email_password'], allow_registration: true,
  primary_color: '#2563eb', background_color: '#ffffff', text_color: '#111827' };

describe.skipIf(!process.env.DATABASE_URL)('native social providers', () => {
  const previous = { ...process.env };
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let appId: string;
  let clientId: string;
  beforeAll(async () => {
    db = (await createTestDb())!;
    Object.assign(process.env, { DATABASE_URL: db.databaseUrl, DATABASE_ADMIN_URL: db.databaseUrl,
      MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true', MCP_OAUTH_DOMAIN: 'native.example.com', PUBLIC_BASE_URL: issuer,
      GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
      APPLE_CLIENT_ID: 'apple-client', APPLE_TEAM_ID: 'team', APPLE_KEY_ID: 'key', APPLE_PRIVATE_KEY: 'configured',
      FACEBOOK_CLIENT_ID: 'facebook-client', FACEBOOK_CLIENT_SECRET: 'facebook-secret',
      GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret',
      LINKEDIN_CLIENT_ID: 'linkedin-client', LINKEDIN_CLIENT_SECRET: 'linkedin-secret',
      X_CLIENT_ID: 'x-client', X_CLIENT_SECRET: 'x-secret' });
    const { privateKey } = await generateKeyPair('RS256');
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'native-social' });
    resetAccessTokenKeyCache();
    mocks.profile.mockImplementation(async (provider: SocialProviderKey) => ({ provider,
      email: `${provider}@example.com`, providerSubject: `${provider}-subject`,
      emailVerified: provider !== 'facebook', name: provider, avatarUrl: null }));
    appId = (await saveNativeApp({ ...policy, identifier: 'com.unlikeotherai.kelpie' }, 'operator@example.com')).id;
    app = await createApp(); await app.ready();
    await register();
  });
  afterAll(async () => { await app?.close(); await db?.cleanup(); process.env = previous; resetAccessTokenKeyCache(); });
  async function register() {
    const result = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      app_id: 'com.unlikeotherai.kelpie', redirect_uris: [redirect], scope: 'openid profile email',
    } });
    expect(result.statusCode, result.body).toBe(201); clientId = result.json().client_id;
  }
  const context = () => new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state: 'app-state',
    scope: 'openid profile email', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256' });
  function cookies(response: Awaited<ReturnType<typeof app.inject>>) {
    return Object.fromEntries(response.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  }
  async function start(provider: SocialProviderKey) {
    const response = await app.inject({ url: `/oauth/social/${provider}?${context()}` });
    expect(response.statusCode, response.body).toBe(302);
    const url = new URL(response.headers.location!);
    return { response, url, state: url.searchParams.get('state')!, cookies: cookies(response) };
  }
  const callback = (provider: SocialProviderKey, state: string, jar: Record<string, string>, code = 'provider-code') =>
    app.inject({ remoteAddress: `203.0.113.${providers.indexOf(provider) + 1}`, method: provider === 'apple' ? 'POST' : 'GET', url: provider === 'apple' ? '/auth/callback/apple' :
      `/auth/callback/${provider}?${new URLSearchParams({ state, code })}`,
      ...(provider === 'apple' ? { payload: { state, code } } : {}), cookies: jar });
  const complete = (state: string, jar: Record<string, string>) => app.inject({ method: 'POST',
    url: '/oauth/social/complete', headers: { origin: issuer }, cookies: jar, payload: { flow_id: state } });

  it('renders every operator-enabled native provider on the hosted login', async () => {
    const page = await app.inject({ url: `/oauth/authorize?${context()}` });
    expect(page.statusCode, page.body).toBe(200);
    for (const provider of providers) expect(page.body).toContain(`/oauth/social/${provider}`);
  });
  it.each(['google', 'apple', 'github', 'linkedin', 'x'] as const)(
    'authenticates %s with browser/provider binding, original evidence, one-use completion and PKCE', async (provider) => {
      const flow = await start(provider);
      expect(flow.state).toMatch(/^native_[A-Za-z0-9_-]{32}$/);
      expect(flow.url.searchParams.get('redirect_uri')).toBe(`${issuer}/auth/callback/${provider}`);
      expect(flow.response.cookies.find((c) => c.name.startsWith('__Host-'))).toMatchObject({
        secure: true, httpOnly: true, path: '/', sameSite: provider === 'apple' ? 'None' : 'Lax',
      });
      const other = provider === 'github' ? 'linkedin' : 'github';
      expect((await callback(other, flow.state, flow.cookies)).statusCode).toBe(401);
      expect((await callback(provider, flow.state, {})).statusCode).toBe(401);
      const response = await callback(provider, flow.state, flow.cookies);
      expect(response.statusCode, response.body).toBe(200);
      expect((await callback(provider, flow.state, flow.cookies)).statusCode).toBe(401);
      if (provider === 'x') {
        expect(response.cookies.some((cookie) => cookie.name === 'uoa_x_social_context')).toBe(false);
        const call = mocks.profile.mock.calls.slice().reverse().find((args) => args[0] === 'x')!;
        expect(call[3]).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(flow.url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(call[3]).digest('base64url'));
      }
      const stored = await db.prisma.nativeOAuthFlow.findUniqueOrThrow({ where: { id: flow.state } });
      const evidence = await db.prisma.authenticationEvidence.findUniqueOrThrow({ where: { id: stored.authenticationEvidenceId! } });
      expect(evidence.method).toBe(provider); expect(evidence.amr).toEqual([provider]);
      const done = await complete(flow.state, cookies(response));
      expect(done.statusCode, done.body).toBe(200);
      expect((await complete(flow.state, cookies(response))).statusCode).toBe(401);
      const target = new URL(done.json().redirect_to);
      expect(target.searchParams.get('state')).toBe('app-state');
      expect(target.searchParams.has('access_token')).toBe(false);
      const exchange = (value: string) => app.inject({ method: 'POST', url: '/oauth/token', payload: {
        code: target.searchParams.get('code'), client_id: clientId, redirect_uri: redirect, code_verifier: value,
      } });
      expect((await exchange('w'.repeat(43))).statusCode).toBe(401);
      const token = await exchange(verifier);
      expect(token.statusCode, token.body).toBe(200);
      expect((await exchange(verifier)).statusCode).toBe(401);
    });

  it('requires Facebook mailbox proof before linking, rejects foreign proof, and reuses the verified subject later', async () => {
    const flow = await start('facebook');
    const pending = await callback('facebook', flow.state, flow.cookies);
    expect(pending.statusCode, pending.body).toBe(200);
    expect(await db.prisma.user.findUnique({ where: { userKey: 'facebook@example.com' } })).toBeNull();
    const jar = { ...flow.cookies, ...cookies(pending) };
    expect((await complete(flow.state, jar)).statusCode).toBe(401);
    expect((await app.inject({ url: `/oauth/social/complete?flow_id=${flow.state}`, cookies: jar })).statusCode).toBe(200);
    const emailCode = mocks.mail.mock.calls.at(-1)![0].code;
    const verify = (code: string) => app.inject({ method: 'POST', url: '/auth/facebook-proof/verify',
      cookies: jar, payload: { code } });
    expect((await verify(emailCode === '000000' ? '000001' : '000000')).statusCode).toBe(401);
    const verified = await verify(emailCode); expect(verified.statusCode, verified.body).toBe(200);
    const target = new URL(verified.json().redirect_url);
    expect(target.searchParams.get('state')).toBe(flow.state);
    const foreign = await start('facebook');
    await callback('facebook', foreign.state, foreign.cookies);
    expect((await callback('facebook', foreign.state, { ...foreign.cookies, ...jar },
      target.searchParams.get('code')!)).statusCode).toBe(401);
    const accepted = await app.inject({ url: target.pathname + target.search, cookies: jar });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await complete(flow.state, { ...jar, ...cookies(accepted) })).statusCode).toBe(200);
    expect((await app.inject({ url: target.pathname + target.search, cookies: jar })).statusCode).toBe(401);
    const count = mocks.mail.mock.calls.length;
    const repeat = await start('facebook');
    expect((await callback('facebook', repeat.state, repeat.cookies)).statusCode).toBe(200);
    expect(mocks.mail.mock.calls).toHaveLength(count);
  });

  it('rejects unverified provider email and keeps enrolled TOTP mandatory', async () => {
    mocks.profile.mockResolvedValueOnce({ provider: 'linkedin', email: 'unverified@example.com',
      emailVerified: false, name: null, avatarUrl: null });
    const bad = await start('linkedin');
    expect((await callback('linkedin', bad.state, bad.cookies)).statusCode).toBe(401);
    expect(await db.prisma.user.findUnique({ where: { userKey: 'unverified@example.com' } })).toBeNull();
    await db.prisma.user.update({ where: { userKey: 'linkedin@example.com' }, data: { twoFaEnabled: true } });
    const flow = await start('linkedin');
    const response = await callback('linkedin', flow.state, flow.cookies);
    expect(response.statusCode, response.body).toBe(200);
    const factor = await complete(flow.state, cookies(response));
    expect(factor.statusCode, factor.body).toBe(200);
    expect(factor.json().twofa_required).toBe(true); expect(factor.json().redirect_to).toBeUndefined();
  });

  it('rejects a removed provider at initiation and invalidates its pending registered flow', async () => {
    const flow = await start('github');
    await saveNativeApp({ ...policy, methods: ['google', 'email_password'] }, 'operator@example.com', appId);
    expect((await callback('github', flow.state, flow.cookies)).statusCode).toBe(400);
    await register();
    expect((await app.inject({ url: `/oauth/social/github?${context()}` })).statusCode).toBe(403);
  });
});
