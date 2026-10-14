import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertEmailDomainAllowedForLogin } from '../../src/services/login-domain-policy.service.js';
import { assertNotBannedAtLogin } from '../../src/services/ban-policy.service.js';
import { AppError } from '../../src/utils/errors.js';

vi.mock('../../src/services/product-team-policy-lock.service.js', () => ({ lockProductTeamPolicyShared: vi.fn() }));

vi.mock('../../src/services/login-domain-policy.service.js', () => ({
  assertEmailDomainAllowedForLogin: vi.fn(),
}));
vi.mock('../../src/services/ban-policy.service.js', () => ({
  assertNotBannedAtLogin: vi.fn(),
}));

const loginWithEmailPasswordMock = vi.fn();
const getOAuthClientMock = vi.fn();
const buildMcpClientConfigMock = vi.fn();
const validateRequestedResourceMock = vi.fn();
const resolveTwoFaPolicyMock = vi.fn();
const finalizePublicOAuthAuthorizationWithSignaturesMock = vi.fn();

vi.mock('../../src/config/env.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/config/env.js')>('../../src/config/env.js');
  return { ...actual, isMcpOAuthPublicProfileEnabled: () => true };
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
    vi.mocked(assertEmailDomainAllowedForLogin).mockReset().mockResolvedValue(undefined);
    vi.mocked(assertNotBannedAtLogin).mockReset().mockResolvedValue(undefined);
    loginWithEmailPasswordMock.mockReset().mockResolvedValue({
      userId: 'user-1',
      twoFaEnabled: false,
      credentialEpoch: 0,
    });
    getOAuthClientMock.mockReset().mockResolvedValue({
      clientId: 'public-client',
      scopes: ['openid', 'profile', 'email'],
      nativeAppRevision: 1,
      redirectUris: ['https://client.example.com/callback'],
    });
    buildMcpClientConfigMock.mockReset().mockReturnValue({
      domain: 'client.example.com',
      enabled_auth_methods: ['email_password'],
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
    app.decorateRequest('adminDb', null);
    app.addHook('onRequest', async (request) => {
      request.adminDb = { $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}) } as never;
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
    expect(finalizePublicOAuthAuthorizationWithSignaturesMock).toHaveBeenCalledWith(
      {
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
        credentialEpoch: 0,
      },
      { prisma: expect.objectContaining({ $transaction: expect.any(Function) }) },
    );

    await app.close();
  });

  it.each(['removed', 'revision', 'callback'])('refuses a client %s change before password/factor effects', async (change) => {
    const current = await getOAuthClientMock.getMockImplementation()!();
    getOAuthClientMock.mockResolvedValueOnce(current).mockResolvedValueOnce(
      change === 'removed' ? null : { ...current,
        ...(change === 'revision' ? { nativeAppRevision: 2 } : { redirectUris: [] }) },
    );
    const { response } = await requestNativeLogin();
    expect(response.statusCode).toBe(400);
    expect(loginWithEmailPasswordMock).not.toHaveBeenCalled();
    expect(resolveTwoFaPolicyMock).not.toHaveBeenCalled();
    expect(finalizePublicOAuthAuthorizationWithSignaturesMock).not.toHaveBeenCalled();
  });

  it('rechecks the current enabled password method before password/factor effects', async () => {
    const config = buildMcpClientConfigMock.getMockImplementation()!();
    buildMcpClientConfigMock.mockReturnValueOnce(config)
      .mockReturnValueOnce({ ...config, enabled_auth_methods: ['google'] });
    const { response } = await requestNativeLogin();
    expect(response.statusCode).toBe(403);
    expect(loginWithEmailPasswordMock).not.toHaveBeenCalled();
    expect(resolveTwoFaPolicyMock).not.toHaveBeenCalled();
  });

  it.each(['allowlist', 'ban'])('refuses current %s policy before any MFA or signing effects', async (policy) => {
    vi.mocked(policy === 'ban' ? assertNotBannedAtLogin : assertEmailDomainAllowedForLogin)
      .mockRejectedValueOnce(new AppError('FORBIDDEN', 403));
    const { tx, response } = await requestNativeLogin();
    expect(response.statusCode).toBe(403);
    expect(assertEmailDomainAllowedForLogin).toHaveBeenCalledWith(
      { userId: 'user-1', domain: 'client.example.com' }, { prisma: tx },
    );
    expect(resolveTwoFaPolicyMock).not.toHaveBeenCalled();
    expect(finalizePublicOAuthAuthorizationWithSignaturesMock).not.toHaveBeenCalled();
  });

  it('preserves an in-transaction client dependency outage as a server failure', async () => {
    const current = await getOAuthClientMock.getMockImplementation()!();
    getOAuthClientMock.mockResolvedValueOnce(current).mockRejectedValueOnce(new Error('dependency unavailable'));
    const { response } = await requestNativeLogin();
    expect(response.statusCode).toBe(500);
    expect(loginWithEmailPasswordMock).not.toHaveBeenCalled();
    expect(resolveTwoFaPolicyMock).not.toHaveBeenCalled();
  });
});

// Fastify.inject exercises request hooks without opening a listener or a DB.
async function requestNativeLogin() {
  const { registerOAuthLoginRoute } = await import('../../src/routes/oauth/login.js');
  const app = Fastify();
  app.decorateRequest('adminDb', null);
  const tx = {};
  app.addHook('onRequest', async (request) => {
    request.adminDb = { $transaction: async (body: (client: unknown) => Promise<unknown>) => body(tx) } as never;
  });
  registerOAuthLoginRoute(app);
  try {
    return { tx, response: await app.inject({ method: 'POST',
      url: '/oauth/login?client_id=public-client&redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback' +
        '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256' +
        '&scope=openid%20profile%20email&resource=https%3A%2F%2Fapi.example.com',
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    }) };
  } finally { await app.close(); }
}
