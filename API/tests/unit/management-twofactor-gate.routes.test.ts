import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ intent: undefined as string | undefined,
  factor: vi.fn(), finish: vi.fn() }));
vi.mock('../../src/middleware/config-verifier.js', () => ({ configVerifier: async (request: {
  config?: object; configUrl?: string;
}) => {
  request.config = { domain: 'example.com', '2fa_enabled': false,
    redirect_urls: ['https://example.com/callback'] };
  request.configUrl = 'https://example.com/config';
} }));
vi.mock('../../src/config/env.js', () => ({ getAuthServiceIdentifier: () => 'uoa',
  requireEnv: () => ({ SHARED_SECRET: 'test-only' }) }));
vi.mock('../../src/plugins/tenant-context.plugin.js', () => ({
  runWithRequestAdminTransaction: async (_request: unknown, callback: (db: object) => unknown) => callback({}),
}));
vi.mock('../../src/services/product-team-policy-lock.service.js', () => ({ lockProductTeamPolicyShared: vi.fn() }));
vi.mock('../../src/services/authentication-epoch.service.js', () => ({ lockAndAssertAuthenticationEpoch: vi.fn() }));
vi.mock('../../src/services/login-log.service.js', () => ({ recordLoginLog: vi.fn() }));
vi.mock('../../src/services/twofactor-login.service.js', () => ({ verifyTwoFactorForLogin: state.factor }));
vi.mock('../../src/services/access-request-flow.service.js', () => ({ finalizeAuthenticatedUser: state.finish }));
vi.mock('../../src/routes/auth/rate-limit-keys.js', () => ({ twoFactorVerifyRateLimiter: async () => undefined }));
vi.mock('../../src/services/twofactor-challenge.service.js', () => ({ verifyTwoFaChallenge: async () => ({
  userId: 'user', credentialEpoch: 0, configUrl: 'https://example.com/config', domain: 'example.com',
  redirectUrl: 'https://example.com/callback', managementIntentId: state.intent,
}) }));

describe('management personal factor with ordinary product 2FA disabled', () => {
  it.each([undefined, 'management-intent'])('accepts only the signed management purpose: %s', async (intent) => {
    state.intent = intent;
    state.factor.mockReset().mockResolvedValue(undefined);
    state.finish.mockReset().mockResolvedValue({ status: 'granted', redirectTo: '/management' });
    const { registerTwoFactorVerifyRoute } = await import('../../src/routes/twofactor/verify.js');
    const app = Fastify();
    registerTwoFactorVerifyRoute(app);
    const response = await app.inject({ method: 'POST', url: '/2fa/verify',
      payload: { twofa_token: 'signed-challenge', code: '123456' } });
    expect(response.statusCode).toBe(intent ? 200 : 401);
    expect(state.factor).toHaveBeenCalledTimes(intent ? 1 : 0);
    expect(state.finish).toHaveBeenCalledTimes(intent ? 1 : 0);
    if (intent) expect(state.finish).toHaveBeenCalledWith(expect.objectContaining({
      managementIntentId: intent, twoFaCompleted: true,
    }), expect.anything());
    await app.close();
  });
});
