import { createHash } from 'node:crypto';

import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const codeVerifier = 'funnel-test-code-verifier-0123456789-abcdefghijkl';
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
const flowQuery =
  `config_url=${encodeURIComponent(configUrl)}&redirect_url=${encodeURIComponent(redirectUrl)}` +
  `&code_challenge=${codeChallenge}&code_challenge_method=S256`;
const adminDomain = 'admin.example.com';
const adminSecret = 'test-admin-token-secret-with-enough-length';
const newPersonEmail = 'funnel-newcomer@example.com';

/**
 * Docs/Auth/signup-funnel-metrics.md: every step of a sign-up is counted per client and UTC day,
 * and nothing that identifies the person (email, token, code, user id) ever reaches the counters.
 */
describe.skipIf(!hasDatabase)('sign-up funnel metrics', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN,
    ADMIN_ACCESS_TOKEN_SECRET: process.env.ADMIN_ACCESS_TOKEN_SECRET,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle!.prisma.authFunnelDailyCount.deleteMany();
    await handle!.prisma.refreshToken.deleteMany();
    await handle!.prisma.sessionAssurance.deleteMany();
    await handle!.prisma.authorizationCode.deleteMany();
    await handle!.prisma.verificationToken.deleteMany();
    await handle!.prisma.loginLog.deleteMany();
    await handle!.prisma.domainRole.deleteMany();
    await handle!.prisma.user.deleteMany();
    await cleanClientDomains(handle!.prisma);

    const jwt = await signTestConfigJwt(baseClientConfigPayload({ user_scope: 'global' }));
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedSetPasswordToken(rawToken: string, overrides?: { expiresAt?: Date; usedAt?: Date }) {
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        email: newPersonEmail,
        userKey: newPersonEmail,
        domain: null,
        configUrl,
        tokenHash: hashEmailToken(rawToken, process.env.SHARED_SECRET!),
        expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 10 * 60_000),
        usedAt: overrides?.usedAt ?? null,
      },
    });
  }

  async function countsByStep(): Promise<Record<string, number>> {
    const rows = await handle!.prisma.authFunnelDailyCount.findMany();
    return Object.fromEntries(rows.map((row) => [`${row.step}:${row.outcome}`, row.count]));
  }

  it('counts every step of an email sign-up for the client, without personal data', async () => {
    const clientHash = await seedDomainSecret(handle!.prisma, 'client.example.com');
    await seedSetPasswordToken('funnel-valid-token');
    await seedSetPasswordToken('funnel-expired-token', { expiresAt: new Date(Date.now() - 60_000) });
    await seedSetPasswordToken('funnel-used-token', { usedAt: new Date() });

    let code = '';
    const app = await createApp();
    await app.ready();
    try {
      // 1. The product opens the auth window; a mid-flow re-render is not a new flow.
      expect((await app.inject({ method: 'GET', url: `/auth?${flowQuery}` })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: `/auth?${flowQuery}&twofa_token=abc` })).statusCode,
      ).toBe(200);

      // 2–3. Registration submissions and what happened to the email behind the generic reply.
      for (const email of [newPersonEmail, 'not-an-email']) {
        const res = await app.inject({ method: 'POST', url: `/auth/register?${flowQuery}`, payload: { email } });
        expect(res.json()).toEqual({ message: 'We sent instructions to your email' });
      }

      // 4. The emailed link: valid, expired, already used, and unknown. A scanner's HEAD is not a person.
      expect((await app.inject({ method: 'HEAD', url: `/auth?${flowQuery}` })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'HEAD', url: `/auth/email/link?${flowQuery}&token=funnel-valid-token` })).statusCode,
      ).toBe(200);
      for (const token of ['funnel-valid-token', 'funnel-expired-token', 'funnel-used-token', 'funnel-unknown']) {
        const res = await app.inject({ method: 'GET', url: `/auth/email/link?${flowQuery}&token=${token}` });
        expect(res.statusCode).toBe(200);
      }

      // 5. A rejected password, then the accepted one that creates the account and issues a code.
      const weak = await app.inject({
        method: 'POST',
        url: `/auth/verify-email?${flowQuery}`,
        payload: { token: 'funnel-valid-token', password: 'short' },
      });
      expect(weak.statusCode).toBe(400);
      const verified = await app.inject({
        method: 'POST',
        url: `/auth/verify-email?${flowQuery}`,
        payload: { token: 'funnel-valid-token', password: 'Long enough password 1' },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      code = (verified.json() as { code: string }).code;
      expect(code).toEqual(expect.any(String));

      // 6. The product exchanges the code once; a replay is rejected with the opaque error.
      const exchange = () =>
        app.inject({
          method: 'POST',
          url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
          headers: { authorization: `Bearer ${clientHash}` },
          payload: { code, redirect_url: redirectUrl, code_verifier: codeVerifier },
        });
      expect((await exchange()).statusCode).toBe(200);
      const replay = await exchange();
      expect(replay.statusCode).toBe(401);
      expect(replay.body).not.toContain('already_used');
    } finally {
      await app.close();
    }

    expect(await countsByStep()).toEqual({
      'flow_started:shown': 1,
      'register_submitted:valid_email': 1,
      'register_submitted:invalid_email': 1,
      'registration_email:verification_sent': 1,
      'email_link_opened:valid_set_password': 1,
      'email_link_opened:expired': 1,
      'email_link_opened:already_used': 1,
      'email_link_opened:invalid': 1,
      'set_password:password_rejected': 1,
      'set_password:succeeded': 1,
      'sign_in_completed:verify_email_set_password': 1,
      'code_exchange:succeeded': 1,
      'code_exchange:rejected_already_used': 1,
    });

    const rows = await handle!.prisma.authFunnelDailyCount.findMany();
    expect(new Set(rows.map((row) => row.domain))).toEqual(new Set(['client.example.com']));
    const today = new Date().toISOString().slice(0, 10);
    expect(new Set(rows.map((row) => row.day.toISOString().slice(0, 10)))).toEqual(new Set([today]));
    const stored = JSON.stringify(rows);
    for (const secret of [newPersonEmail, 'funnel-valid-token', code, '@']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('counts a known person registering again as an inline sign-in prompt', async () => {
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({ user_scope: 'global', existing_user_registration_behavior: 'inline_sign_in' }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
    await handle!.prisma.user.create({ data: { email: newPersonEmail, userKey: newPersonEmail } });

    const app = await createApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/auth/register?${flowQuery}`,
        payload: { email: newPersonEmail },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }

    expect(await countsByStep()).toEqual({
      'register_submitted:valid_email': 1,
      'registration_email:existing_user_inline': 1,
    });
  });

  it('serves the per-client summary only to platform superusers', async () => {
    const day = new Date(Date.UTC(2026, 9, 20));
    const nextDay = new Date(Date.UTC(2026, 9, 21));
    await handle!.prisma.authFunnelDailyCount.createMany({
      data: [
        { day, domain: 'client.example.com', step: 'flow_started', outcome: 'shown', count: 5 },
        { day: nextDay, domain: 'client.example.com', step: 'flow_started', outcome: 'shown', count: 2 },
        { day, domain: 'client.example.com', step: 'register_submitted', outcome: 'valid_email', count: 3 },
        { day, domain: 'other.example.com', step: 'flow_started', outcome: 'shown', count: 9 },
      ],
    });
    const admin = await handle!.prisma.user.create({
      data: { email: 'operator@example.com', userKey: 'operator@example.com' },
      select: { id: true, tokenVersion: true },
    });
    await handle!.prisma.domainRole.create({
      data: { domain: adminDomain, userId: admin.id, role: 'SUPERUSER' },
    });
    const token = await new SignJWT({ email: 'operator@example.com', domain: adminDomain, client_id: 'admin', role: 'superuser', tv: admin.tokenVersion })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(admin.id)
      .setIssuer('uoa-auth-service')
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(new TextEncoder().encode(adminSecret));

    const app = await createApp();
    await app.ready();
    try {
      const url = '/internal/admin/auth-funnel?from=2026-10-20&to=2026-10-21&domain=client.example.com';
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);

      const reversed = await app.inject({
        method: 'GET',
        url: '/internal/admin/auth-funnel?from=2026-10-21&to=2026-10-20',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(reversed.statusCode).toBe(400);
      expect(reversed.json()).toMatchObject({ code: 'INVALID_DATE_RANGE' });

      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        from: '2026-10-20',
        to: '2026-10-21',
        domain: 'client.example.com',
        domains: ['client.example.com', 'other.example.com'],
        totals: [
          { step: 'flow_started', outcome: 'shown', count: 7 },
          { step: 'register_submitted', outcome: 'valid_email', count: 3 },
        ],
        days: [
          { day: '2026-10-20', step: 'flow_started', outcome: 'shown', count: 5 },
          { day: '2026-10-20', step: 'register_submitted', outcome: 'valid_email', count: 3 },
          { day: '2026-10-21', step: 'flow_started', outcome: 'shown', count: 2 },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
