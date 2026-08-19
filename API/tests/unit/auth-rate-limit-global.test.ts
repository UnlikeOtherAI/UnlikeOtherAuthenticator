import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

// Reset requests never reveal whether the email exists, so a no-op service mock is enough —
// the request under test must still succeed (and consume its buckets) end to end.
vi.mock('../../src/services/auth-reset-password.service.js', () => ({
  requestPasswordReset: vi.fn(async () => undefined),
  resetPasswordWithToken: vi.fn(async () => undefined),
}));

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: {
    query?: { config_url?: string };
    configUrl?: string;
    config?: ClientConfig;
  }): Promise<void> => {
    request.configUrl = request.query?.config_url;
    request.config = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: true,
      registration_mode: 'password_required',
      '2fa_enabled': false,
      debug_enabled: false,
      session: {
        remember_me_enabled: true,
        remember_me_default: true,
        short_refresh_token_ttl_hours: 1,
        long_refresh_token_ttl_days: 30,
      },
    } as ClientConfig;
  },
}));

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(),
  getAdminPrisma: vi.fn(),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

async function buildApp(): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const { registerAuthResetPasswordRoutes } = await import(
    '../../src/routes/auth/reset-password.js'
  );
  const app = fastify({ trustProxy: 1 });
  app.decorateRequest('adminDb', {
    getter() {
      return {} as PrismaClient;
    },
  });
  registerAuthResetPasswordRoutes(app);
  await app.ready();
  return app;
}

// Every exported limiter in rate-limit-keys.ts, with the `<prefix>:global` key
// it must consume when the global-bucket wiring is present — or null when the
// limiter deliberately has no global bucket. `windows` in rate-limiter.ts is
// one module-level Map keyed by the key string, so a limiter can be driven
// with a bare request and its effect read back with a probe limit of 1.
type LimiterCase = { globalKey: string | null };

async function globalKeys(): Promise<Record<string, LimiterCase>> {
  const keys = await import('../../src/routes/auth/rate-limit-keys.js');
  const cases: Record<string, LimiterCase> = {
    loginRateLimiter: { globalKey: 'auth:login:global' },
    registerRateLimiter: { globalKey: 'auth:register:global' },
    authStartRateLimiter: { globalKey: 'auth:start:global' },
    verifyCodeRateLimiter: { globalKey: 'auth:verify-code:global' },
    selectTeamRateLimiter: { globalKey: 'auth:select-team:global' },
    sessionChoicesRateLimiter: { globalKey: 'auth:session-choices:global' },
    resetRequestRateLimiter: { globalKey: 'auth:reset-request:global' },
    tokenConsumeRateLimiter: { globalKey: 'auth:token-consume:global' },
    tokenExchangeRateLimiter: { globalKey: 'auth:token-exchange:global' },
    tokenExchangePreAuthRateLimiter: { globalKey: 'auth:token-exchange:global' },
    confidentialTokenExchangeDomainRateLimiter: { globalKey: null },
    twoFactorVerifyRateLimiter: { globalKey: 'auth:twofa-verify:global' },
    twoFactorSetupRateLimiter: { globalKey: 'auth:twofa-setup:global' },
    twoFactorEnrollRateLimiter: { globalKey: 'auth:twofa-enroll:global' },
    twoFactorDisableRateLimiter: { globalKey: 'auth:twofa-disable:global' },
    socialCallbackRateLimiter: { globalKey: 'auth:social-callback:global' },
    configFetchRateLimiter: { globalKey: 'auth:config-fetch:global' },
    revokeRateLimiter: { globalKey: null },
    emailSendRateLimiter: { globalKey: null },
    emailTeamInviteOpenRateLimiter: { globalKey: 'auth:email-team-invite-open:global' },
  };
  // A limiter added to rate-limit-keys.ts without a row above fails here, so
  // the table can never silently fall behind the module's exports again.
  expect(Object.keys(cases).sort()).toEqual(Object.keys(keys).sort());
  return cases;
}

// ip: '', so request.ip is never resolved. For the global-bucket cases the
// body hash and domain are irrelevant — only the global key is read back.
const bareRequest = { ip: '', body: {}, config: { domain: 'client.example.com' } };

async function consumeAndProbe(name: string, globalKey: string): Promise<void> {
  vi.resetModules();
  // The probe must share the post-reset module registry with the limiter under
  // test, so both come from the same fresh import of rate-limit-keys.ts.
  const keys = await import('../../src/routes/auth/rate-limit-keys.js');
  const { createRateLimiter } = await import('../../src/middleware/rate-limiter.js');
  const limiter = keys[name as keyof typeof keys] as unknown as (
    request: FastifyRequest,
  ) => Promise<void>;

  await limiter(bareRequest as FastifyRequest);

  const probe = createRateLimiter({
    keyBuilder: () => globalKey,
    limit: 1,
    windowMs: 60 * 1000,
  });
  await expect(probe({} as FastifyRequest)).rejects.toMatchObject({
    code: 'RATE_LIMITED',
    statusCode: 429,
  });
}

describe('auth limiters global ceiling', () => {
  it('POST /auth/reset-password/request consumes the fixed global bucket even when IP and email keys are fresh', async () => {
    // request.ip is attacker's choice under trustProxy: 1, so a global-only request — fresh IP,
    // fresh email — must still consume the fixed `auth:reset-request:global` key. Reset the
    // module registry so this file's limiter state cannot leak in from other tests.
    vi.resetModules();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password/request?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
        remoteAddress: '203.0.113.1',
        payload: { email: 'global-check@example.com' },
      });
      expect(res.statusCode).toBe(200);

      // Read the same key back: the global ceiling is 12k/min, so a probe limit 1 must refuse if
      // the request above consumed it — and pass if no global bucket exists. Dynamic import so
      // the probe shares the post-reset module registry with the route under test.
      const { createRateLimiter } = await import('../../src/middleware/rate-limiter.js');
      const probe = createRateLimiter({
        keyBuilder: () => 'auth:reset-request:global',
        limit: 1,
        windowMs: 60 * 1000,
      });
      await expect(probe({} as Parameters<typeof probe>[0])).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
      });
    } finally {
      await app.close();
    }
  });

  it('table covers every limiter exported from rate-limit-keys.ts', async () => {
    await globalKeys();
  });

  it('every limiter with a global bucket consumes its global key', async () => {
    const cases = await globalKeys();

    for (const [name, { globalKey }] of Object.entries(cases)) {
      if (!globalKey) continue;
      await consumeAndProbe(name, globalKey);
    }
  });

  it('limiters without a global bucket do not consume one', async () => {
    const cases = await globalKeys();

    for (const [name, { globalKey }] of Object.entries(cases)) {
      if (globalKey !== null) continue;
      vi.resetModules();
      const freshKeys = await import('../../src/routes/auth/rate-limit-keys.js');
      const { createRateLimiter } = await import('../../src/middleware/rate-limiter.js');
      const limiter = freshKeys[name as keyof typeof freshKeys] as unknown as (
        request: FastifyRequest,
      ) => Promise<void>;

      await limiter(bareRequest as FastifyRequest);

      // The plausible global key for this limiter must still be fresh — a
      // stray globalRateLimiter wiring would have consumed it.
      const prefix =
        name === 'emailSendRateLimiter'
          ? 'email:send'
          : `auth:${name === 'revokeRateLimiter' ? 'revoke' : 'token-exchange:confidential'}`;
      const probe = createRateLimiter({
        keyBuilder: () => `${prefix}:global`,
        limit: 1,
        windowMs: 60 * 1000,
      });
      await expect(probe({} as FastifyRequest)).resolves.toBeUndefined();
    }
  });
});
