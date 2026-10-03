import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  config: vi.fn(),
  profile: vi.fn(),
  client: vi.fn(),
  start: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('../../src/middleware/config-verifier.js', () => ({ configVerifier: effects.config }));
vi.mock('../../src/routes/oauth/public-profile-guard.js', () => ({
  requireMcpOAuthPublicProfile: effects.profile,
}));
vi.mock('../../src/services/oauth/client.service.js', () => ({ getOAuthClient: effects.client }));
vi.mock('../../src/services/lifecycle-status.service.js', () => ({
  startLifecycleStatus: effects.start,
  verifyLifecycleStatus: effects.verify,
}));

import { registerLifecycleStatusRoutes } from '../../src/routes/auth/lifecycle-status.js';
import { registerOAuthLifecycleStatus } from '../../src/routes/oauth/lifecycle-status.js';
import { parseEnv } from '../../src/config/env.js';

const challengeId = '2df2ccf7-8256-40bd-a54b-3fafb60be547';
const cases = [
  ['/auth/lifecycle-status/start', { email: 'user@example.com' }],
  ['/auth/lifecycle-status/verify', { challengeId, code: '123456', twoFactorCode: '654321' }],
  ['/oauth/lifecycle-status/start', { email: 'user@example.com' }],
  ['/oauth/lifecycle-status/verify', { challengeId, code: '123456', twoFactorCode: '654321' }],
] as const;
function makeApp() {
  const app = Fastify();
  registerLifecycleStatusRoutes(app);
  registerOAuthLifecycleStatus(app);
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MCP_OAUTH_DOMAIN', 'native.example.com');
  effects.config.mockImplementation(async (request) => {
    request.config = { domain: 'client.example.com' };
    request.configUrl = 'https://client.example.com/config';
  });
  effects.profile.mockResolvedValue(undefined);
  effects.client.mockResolvedValue({
    clientId: 'native-client',
    redirectUris: ['com.example.app://callback'],
    nativeAppRevision: 7,
  });
  effects.start.mockResolvedValue({ ok: true, challengeId });
  effects.verify.mockResolvedValue({ user: { status: 'DISABLED' }, organisations: [], teams: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe('server-owned access-status diagnostic gate', () => {
  it.each([undefined, 'false', 'true'])('parses explicit opt-in %s', (flag) => {
    expect(
      parseEnv({
        NODE_ENV: 'test',
        SHARED_SECRET: 'test-shared-secret-with-enough-length',
        AUTH_ACCESS_STATUS_ENABLED: flag,
      }).AUTH_ACCESS_STATUS_ENABLED,
    ).toBe(flag === 'true');
  });
  it.each([undefined, 'false'])(
    'refuses all routes before configuration/client/proof work when %s',
    async (flag) => {
      vi.stubEnv('AUTH_ACCESS_STATUS_ENABLED', flag);
      vi.stubEnv('DEBUG_ENABLED', 'true');
      const app = makeApp();
      try {
        for (const [path, payload] of cases) {
          const response = await app.inject({
            method: 'POST',
            url: `${path}?config_url=https://client.example.com/config&client_id=native-client&redirect_uri=com.example.app%3A%2F%2Fcallback&access_status_enabled=true`,
            payload,
          });
          expect(response.statusCode).toBe(404);
        }
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/auth/lifecycle-status/start',
              headers: { 'content-type': 'application/json' },
              payload: '{invalid',
            })
          ).statusCode,
        ).toBe(404);
        for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('passes enabled requests through existing website/native contexts and proof checks', async () => {
    vi.stubEnv('AUTH_ACCESS_STATUS_ENABLED', 'true');
    const app = makeApp();
    try {
      for (const [path, payload] of cases) {
        const query = path.startsWith('/oauth')
          ? 'client_id=native-client&redirect_uri=com.example.app%3A%2F%2Fcallback'
          : 'config_url=https://client.example.com/config';
        const response = await app.inject({ method: 'POST', url: `${path}?${query}`, payload });
        expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
      }
      expect(effects.config).toHaveBeenCalledTimes(2);
      expect(effects.profile).toHaveBeenCalledTimes(2);
      expect(effects.client).toHaveBeenCalledTimes(2);
      expect(effects.verify).toHaveBeenCalledWith(
        expect.objectContaining({ challengeId, code: '123456', twoFactorCode: '654321' }),
      );
      expect(effects.verify).toHaveBeenCalledWith(
        expect.objectContaining({
          native: {
            clientId: 'native-client',
            redirectUri: 'com.example.app://callback',
            revision: 7,
          },
        }),
      );
      vi.stubEnv('AUTH_ACCESS_STATUS_ENABLED', 'false');
      vi.clearAllMocks();
      for (const [path, payload] of cases.filter(([path]) => path.endsWith('/verify'))) {
        expect((await app.inject({ method: 'POST', url: path, payload })).statusCode).toBe(404);
      }
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
