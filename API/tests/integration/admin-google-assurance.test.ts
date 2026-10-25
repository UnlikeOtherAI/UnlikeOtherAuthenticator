import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from '../helpers/test-config.js';

const domain = 'admin.example.com';
const origin = `https://${domain}`;
const configUrl = `${origin}/internal/admin/config`;
const redirectUrl = `${origin}/admin/auth/callback`;
const verifier = 'admin-google-verifier-abcdefghijklmnopqrstuvwxyz';
const email = 'admin-google@example.com';

describe.skipIf(!process.env.DATABASE_URL)('Google admin login with original assurance', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  const keys = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'ADMIN_AUTH_DOMAIN', 'PUBLIC_BASE_URL',
    'ADMIN_CONFIG_JWT', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  beforeAll(async () => {
    db = (await createTestDb())!;
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.DATABASE_ADMIN_URL = db.databaseUrl;
    process.env.ADMIN_AUTH_DOMAIN = domain;
    process.env.PUBLIC_BASE_URL = origin;
    process.env.GOOGLE_CLIENT_ID = 'google-test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-test-secret';
    process.env.ADMIN_CONFIG_JWT = await signTestConfigJwt(baseClientConfigPayload({ domain,
      redirect_urls: [redirectUrl], enabled_auth_methods: ['google'], allow_registration: false,
      org_features: { enabled: false }, login_flow: { email_code_enabled: false, team_selection: 'off' },
      session: { access_token_ttl_minutes: 15, short_refresh_token_ttl_hours: 1 },
    }));
    const configFetch = await createTestConfigFetchHandler(process.env.ADMIN_CONFIG_JWT);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'google-test-access-token' });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ email, email_verified: true, name: 'Admin test' });
      }
      return configFetch(input);
    }));
    const user = await db.prisma.user.create({ data: { email, userKey: email } });
    await db.prisma.domainRole.create({ data: { domain, userId: user.id, role: 'SUPERUSER' } });
    await disconnectPrisma();
    app = await createApp();
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await disconnectPrisma();
    await db?.cleanup();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
  });

  let ip = 1;
  type Session = { accessToken: string; cookie: string };
  function post(path: string, payload: unknown, session?: Session) {
    return app.inject({ method: 'POST', remoteAddress: `192.0.2.${ip++}`,
      url: `/internal/admin/${path}?config_url=${encodeURIComponent(configUrl)}`,
      headers: { origin, 'content-type': 'application/json', ...(session ? {
        authorization: `Bearer ${session.accessToken}`, cookie: session.cookie,
      } : {}) }, payload });
  }
  const readSession = (session: Session) => app.inject({ method: 'GET', url: '/internal/admin/session',
    headers: { authorization: `Bearer ${session.accessToken}` } });

  async function googleLogin() {
    const start = await app.inject({ method: 'GET', url: `/auth/social/google?${new URLSearchParams({
      config_url: configUrl, redirect_url: redirectUrl,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })}` });
    expect(start.statusCode).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const cookies = start.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(';')[0];
    const callback = await app.inject({ method: 'GET',
      url: `/auth/callback/google?${new URLSearchParams({ code: 'google-test-code', state })}`,
      headers: { cookie } });
    expect(callback.statusCode).toBe(302);
    const code = new URL(String(callback.headers.location)).searchParams.get('code');
    expect(code).toBeTruthy();
    const exchange = await post('token', { code, redirect_url: redirectUrl, code_verifier: verifier });
    expect(exchange.statusCode, exchange.body).toBe(200);
    expect(Object.keys(exchange.json()).sort()).toEqual(['access_token', 'expires_in', 'token_type']);
    return { accessToken: exchange.json<{ access_token: string }>().access_token,
      cookie: String(exchange.headers['set-cookie']).split(';')[0] };
  }

  async function proofAndFamily(session: Session) {
    const claims = decodeJwt(session.accessToken);
    expect(claims.assurance_id).toEqual(expect.any(String));
    const proof = await db.prisma.sessionAssurance.findUniqueOrThrow({ where: { id: claims.assurance_id as string } });
    const family = await db.prisma.refreshToken.findUniqueOrThrow({ where: {
      tokenHash: hashRefreshToken(session.cookie.split('=')[1], process.env.SHARED_SECRET!),
    } });
    expect(proof.method).toBe('independent');
    expect(proof.authenticatedAt).toBeNull();
    expect(proof.amr).toContain('google');
    expect(family.expiresAt.getTime()).toBeLessThanOrEqual(Number(claims.exp) * 1000);
    expect(proof.expiresAt.getTime()).toBeLessThanOrEqual(family.expiresAt.getTime());
    return { proof, family };
  }

  it('loads the session after Google and keeps debug descendants valid until source logout', async () => {
    const source = await googleLogin();
    const session = await readSession(source);
    expect(session.statusCode, session.body).toBe(200);
    const original = await proofAndFamily(source);
    expect(original.family.expiresAt.getTime() - original.family.createdAt.getTime()).toBeLessThanOrEqual(15 * 60_000);
    const issued = await post('debug-login/issue', {}, source);
    expect(issued.statusCode, issued.body).toBe(200);
    const redeemed = await post('debug-login/redeem', { token: issued.json<{ token: string }>().token });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(Object.keys(redeemed.json()).sort()).toEqual(['access_token', 'expires_in', 'token_type']);
    const child = { accessToken: redeemed.json<{ access_token: string }>().access_token,
      cookie: String(redeemed.headers['set-cookie']).split(';')[0] };
    expect((await readSession(child)).statusCode).toBe(200);
    const inherited = await proofAndFamily(child);
    expect(inherited.proof.parentId).toBe(original.proof.id);
    expect(inherited.proof.expiresAt.getTime()).toBeLessThanOrEqual(original.proof.expiresAt.getTime());
    expect(inherited.family.familyId).not.toBe(original.family.familyId);
    expect((await post('debug-login/issue', {}, child)).statusCode).toBe(200);
    expect((await readSession(source)).statusCode).toBe(200);
    expect((await post('logout', {}, source)).statusCode).toBe(200);
    expect((await readSession(source)).statusCode).toBe(401);
    expect((await readSession(child)).statusCode).toBe(401);
  });
});
