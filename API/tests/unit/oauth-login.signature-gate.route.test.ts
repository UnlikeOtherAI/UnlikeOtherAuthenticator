import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loginWithEmailPasswordMock = vi.fn();
const getOAuthClientMock = vi.fn();
const buildMcpClientConfigMock = vi.fn();
const validateRequestedResourceMock = vi.fn();
const resolveTwoFaPolicyMock = vi.fn();
const finalizePublicOAuthAuthorizationWithSignaturesMock = vi.fn();

vi.mock('../../src/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/env.js')>(
    '../../src/config/env.js',
  );
  return { ...actual, isMcpOAuthEnabled: () => true };
});

vi.mock('../../src/services/auth-login.service.js', () => ({
  loginWithEmailPassword: (...args: unknown[]) => loginWithEmailPasswordMock(...args),
}));

vi.mock('../../src/services/oauth/client.service.js', () => ({
  getOAuthClient: (...args: unknown[]) => getOAuthClientMock(...args),
}));

vi.mock('../../src/services/oauth/config.service.js', () => ({
  buildMcpClientConfig: (...args: unknown[]) => buildMcpClientConfigMock(...args),
}));

vi.mock('../../src/services/oauth/resource-validation.service.js', () => ({
  validateRequestedResource: (...args: unknown[]) => validateRequestedResourceMock(...args),
}));

vi.mock('../../src/services/twofactor-policy.service.js', () => ({
  resolveTwoFaPolicy: (...args: unknown[]) => resolveTwoFaPolicyMock(...args),
}));

vi.mock('../../src/services/signature-continuation.service.js', () => ({
  finalizePublicOAuthAuthorizationWithSignatures: (...args: unknown[]) =>
    finalizePublicOAuthAuthorizationWithSignaturesMock(...args),
}));

describe('POST /oauth/login signature gate', () => {
  beforeEach(() => {
    loginWithEmailPasswordMock.mockReset().mockResolvedValue({
      userId: 'user-1',
      twoFaEnabled: false,
    });
    getOAuthClientMock.mockReset().mockResolvedValue({
      clientId: 'public-client',
      redirectUris: ['https://client.example.com/callback'],
    });
    buildMcpClientConfigMock.mockReset().mockReturnValue({
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/callback'],
      session: { remember_me_default: true },
    });
    validateRequestedResourceMock.mockReset().mockReturnValue('https://api.example.com');
    resolveTwoFaPolicyMock.mockReset().mockResolvedValue('OFF');
    finalizePublicOAuthAuthorizationWithSignaturesMock.mockReset().mockResolvedValue({
      status: 'signing_required',
      signingToken: 'opaque-capability',
      redirectTo: 'https://auth.example.com/auth?flow=signatures',
      policyRevision: 4,
    });
  });

  it('preserves public OAuth state, scope, resource, redirect, and PKCE at the gate', async () => {
    const { registerOAuthLoginRoute } = await import('../../src/routes/oauth/login.js');
    const app = Fastify();
    app.decorateRequest('withTenantTx', null);
    app.addHook('onRequest', async (request) => {
      request.withTenantTx = async (callback) => callback({} as never);
    });
    registerOAuthLoginRoute(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url:
        '/oauth/login?client_id=public-client' +
        '&redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback' +
        '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
        '&code_challenge_method=S256' +
        '&state=exact-state' +
        '&scope=openid%20profile%20email' +
        '&resource=https%3A%2F%2Fapi.example.com',
      payload: { email: 'user@example.com', password: 'Abcdef1!', remember_me: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      redirect_to: 'https://auth.example.com/auth?flow=signatures',
    });
    expect(finalizePublicOAuthAuthorizationWithSignaturesMock).toHaveBeenCalledWith({
      userId: 'user-1',
      domain: 'client.example.com',
      oauthClientId: 'public-client',
      redirectUrl: 'https://client.example.com/callback',
      resource: 'https://api.example.com',
      state: 'exact-state',
      scope: 'openid profile email',
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      rememberMe: false,
      authMethod: 'email_password',
      twoFaCompleted: false,
    });

    await app.close();
  });
});
