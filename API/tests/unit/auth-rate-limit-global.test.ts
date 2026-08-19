import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

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

      // Read the same key back: the global ceiling is 2k/min, so a probe limit 1 must refuse if
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
});
