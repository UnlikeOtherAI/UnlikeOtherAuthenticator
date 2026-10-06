import { signAccessToken } from '../../src/services/token-signing.service.js';
import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { createHash, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload, signTestConfigJwt } from '../helpers/test-config.js';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueTokenPairForUser } from '../../src/services/token.service.js';
import { adminSessionCookieName } from '../../src/services/admin-debug-session.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';

const domain = 'admin.example.com';
const origin = `https://${domain}`;
const configUrl = `${origin}/internal/admin/config`;
const config = validateConfigFields(baseClientConfigPayload({ domain,
  redirect_urls: [`${origin}/admin/auth/callback`], enabled_auth_methods: ['google'],
  allow_registration: false, org_features: { enabled: false },
  login_flow: { email_code_enabled: false, team_selection: 'off' } }));

describe.skipIf(!process.env.DATABASE_URL)('first-party admin debug login durable routes', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  const keys = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'ADMIN_AUTH_DOMAIN', 'PUBLIC_BASE_URL', 'ADMIN_CONFIG_JWT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  beforeAll(async () => {
    db = (await createTestDb())!;
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.DATABASE_ADMIN_URL = db.databaseUrl;
    process.env.ADMIN_AUTH_DOMAIN = domain;
    process.env.PUBLIC_BASE_URL = origin;
    process.env.ADMIN_CONFIG_JWT = await signTestConfigJwt(config);
    await disconnectPrisma();
    app = await createApp(); await app.ready();
  });
  afterAll(async () => {
    await app?.close(); await disconnectPrisma(); await db?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
  });
  async function source(userId?: string) {
    const user = userId ? await db.prisma.user.findUniqueOrThrow({ where: { id: userId } })
      : await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    await db.prisma.domainRole.upsert({ where: { domain_userId: { domain, userId: user.id } },
      create: { domain, userId: user.id, role: 'SUPERUSER' }, update: { role: 'SUPERUSER' } });
    const refresh = await issueRefreshToken({ userId: user.id, domain, clientId: `admin:${domain}`, configUrl,
      twoFaCompleted: true }, { prisma: db.prisma });
    const pair = await issueTokenPairForUser({ config, configUrl, userId: user.id, refreshToken: refresh.refreshToken,
      refreshTokenExpiresInSeconds: refresh.expiresInSeconds }, { prisma: db.prisma, adminPrisma: db.prisma });
    const cookie = `${adminSessionCookieName(pair.accessToken)}=${pair.refreshToken}`;
    return { user, pair, cookie };
  }
  let ip = 1;
  function request(action: string, payload: unknown, source?: Awaited<ReturnType<typeof source>>) {
    return app.inject({ remoteAddress: `192.0.2.${ip++}`, method: 'POST', url: `/internal/admin/${action}?config_url=${encodeURIComponent(configUrl)}`,
      headers: { origin, 'content-type': 'application/json',
        ...(source ? { authorization: `Bearer ${source.pair.accessToken}`, cookie: source.cookie } : {}) }, payload });
  }
  it('normal PKCE token exchange installs the private ownership cookie and issues a usable admin code', async () => {
    const a = await source();
    const verifier = 'admin-debug-login-verifier-abcdefghijklmnopqrstuvwxyz';
    const code = await issueAuthorizationCode({ userId: a.user.id, domain, configUrl,
      redirectUrl: `${origin}/admin/auth/callback`, codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256', twoFaCompleted: true, credentialEpoch: a.user.tokenVersion }, { prisma: db.prisma });
    const response = await request('token', { code: code.code, redirect_url: `${origin}/admin/auth/callback`, code_verifier: verifier });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['access_token', 'expires_in', 'token_type']);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    const pair = response.json<{ access_token: string; expires_in: number }>();
    const issued = await request('debug-login/issue', {}, { ...a, cookie, pair: { ...a.pair, accessToken: pair.access_token } });
    expect(issued.statusCode).toBe(200);
    expect(issued.json<{ expires_in: number }>().expires_in).toBeLessThanOrEqual(pair.expires_in);
    expect((await request('debug-login/redeem', { token: issued.json<{ token: string }>().token })).statusCode).toBe(200);
  });
  it('issues, renews and consumes once into a separately signed independent family', async () => {
    const a = await source();
    const b = await source(a.user.id);
    expect(a.pair.accessToken).not.toBe(b.pair.accessToken);
    expect(decodeJwt(a.pair.accessToken).client_id).toBe(`admin:${domain}`);
    const issue = await request('debug-login/issue', {}, a); expect(issue.statusCode).toBe(200);
    const old = issue.json<{ token: string }>().token;
    const renewal = await request('debug-login/issue', { previous_token: old }, a);
    expect(renewal.statusCode).toBe(200);
    expect((await request('debug-login/redeem', { token: old })).statusCode).toBe(401);
    const grant = renewal.json<{ token: string; url: string }>();
    expect(grant.url).toBe(`${origin}/admin/login`);
    const raced = await Promise.all([1, 2].map(() => request('debug-login/redeem', { token: grant.token })));
    expect(raced.map(r => r.statusCode).sort()).toEqual([200, 401]);
    const winner = raced.find(r => r.statusCode === 200)!;
    const recipient = winner.json<{ access_token: string }>();
    expect(Object.keys(winner.json()).sort()).toEqual(['access_token', 'expires_in', 'token_type']);
    expect(recipient.access_token).not.toBe(a.pair.accessToken);
    const cookieHeader = String(winner.headers['set-cookie']);
    expect(cookieHeader).toContain('HttpOnly'); expect(cookieHeader).toContain('Secure'); expect(cookieHeader).toContain('SameSite=Strict');
    const raw = cookieHeader.split(';')[0].split('=')[1];
    const recipientRow = await db.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(raw, process.env.SHARED_SECRET!) } });
    const sourceRow = await db.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(a.pair.refreshToken, process.env.SHARED_SECRET!) } });
    expect(recipientRow.familyId).not.toBe(sourceRow.familyId);
    const unused = (await request('debug-login/issue', {}, a)).json<{ token: string }>();
    expect((await request('logout', {}, a)).statusCode).toBe(200);
    expect((await request('debug-login/redeem', { token: unused.token })).statusCode).toBe(401);
    expect((await db.prisma.refreshToken.findUniqueOrThrow({ where: { id: recipientRow.id } })).revokedAt).toBeNull();
    expect((await request('logout', {}, { ...a, cookie: cookieHeader.split(';')[0], pair: { ...a.pair, accessToken: recipient.access_token } })).statusCode).toBe(200);
    expect((await request('debug-login/issue', {}, b)).statusCode).toBe(200);
  });
  it('refuses wrong source cookie, wrong config/origin, customer bearer, current demotion and expiry', async () => {
    const a = await source(); const b = await source(a.user.id);
    const mismatched = { ...a, cookie: b.cookie };
    expect((await request('debug-login/issue', {}, mismatched)).statusCode).toBe(401);
    const grant = (await request('debug-login/issue', {}, a)).json<{ token: string }>();
    const customerBearer = await signAccessToken({ userId: a.user.id, email: a.user.email!, domain: 'customer.example.com',
      role: 'superuser', clientId: 'customer-client', sharedSecret: process.env.SHARED_SECRET!, ttl: '30m',
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!, tokenVersion: 0, relyingPartyToken: true });
    const customer = await request('debug-login/issue', {}, { ...a, pair: { ...a.pair, accessToken: customerBearer } });
    expect(customer.statusCode).toBe(401);

    for (const headers of [{ origin: 'https://evil.example.com' }, { origin }]) {
      const url = headers.origin === origin ? `${origin}/other-config` : configUrl;
      const r = await app.inject({ remoteAddress: `192.0.2.${ip++}`, method: 'POST', url: `/internal/admin/debug-login/redeem?config_url=${encodeURIComponent(url)}`,
        headers: { ...headers, 'content-type': 'application/json' }, payload: { token: grant.token } });
      expect(r.statusCode).toBe(401);
    }
    const product = await app.inject({ remoteAddress: `192.0.2.${ip++}`, method: 'POST', url: `/auth/debug-login/redeem?config_url=${encodeURIComponent(configUrl)}`,
      headers: { authorization: `Bearer ${a.pair.accessToken}` }, payload: { token: grant.token } });
    expect(product.statusCode).not.toBe(200);
    await db.prisma.domainRole.update({ where: { domain_userId: { domain, userId: a.user.id } }, data: { role: 'USER' } });
    expect((await request('debug-login/redeem', { token: grant.token })).statusCode).toBe(401);
    await db.prisma.domainRole.update({ where: { domain_userId: { domain, userId: a.user.id } }, data: { role: 'SUPERUSER' } });
    await db.prisma.debugLoginGrant.updateMany({ where: { userId: a.user.id }, data: { expiresAt: new Date(0) } });
    expect((await request('debug-login/redeem', { token: grant.token })).statusCode).toBe(401);
  });
});
