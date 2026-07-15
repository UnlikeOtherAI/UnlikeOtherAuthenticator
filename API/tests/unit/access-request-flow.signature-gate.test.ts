import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';

const assertEmailDomainAllowedForLoginMock = vi.fn();
const assertNotBannedAtLoginMock = vi.fn();
const handlePostAuthenticationAccessRequestMock = vi.fn();
const finalizeConfigAuthorizationWithSignaturesMock = vi.fn();

vi.mock('../../src/services/login-domain-policy.service.js', () => ({
  assertEmailDomainAllowedForLogin: (...args: unknown[]) =>
    assertEmailDomainAllowedForLoginMock(...args),
}));

vi.mock('../../src/services/ban-policy.service.js', () => ({
  assertNotBannedAtLogin: (...args: unknown[]) => assertNotBannedAtLoginMock(...args),
}));

vi.mock('../../src/services/access-request.service.js', () => ({
  handlePostAuthenticationAccessRequest: (...args: unknown[]) =>
    handlePostAuthenticationAccessRequestMock(...args),
}));

vi.mock('../../src/services/signature-continuation.service.js', () => ({
  finalizeConfigAuthorizationWithSignatures: (...args: unknown[]) =>
    finalizeConfigAuthorizationWithSignaturesMock(...args),
}));

const config = {
  domain: 'client.example.com',
  redirect_urls: ['https://client.example.com/oauth/callback'],
} as ClientConfig;

describe('shared post-authentication signature gate', () => {
  beforeEach(() => {
    assertEmailDomainAllowedForLoginMock.mockReset().mockResolvedValue(undefined);
    assertNotBannedAtLoginMock.mockReset().mockResolvedValue(undefined);
    handlePostAuthenticationAccessRequestMock.mockReset();
    finalizeConfigAuthorizationWithSignaturesMock.mockReset();
  });

  it('forwards the exact authenticated flow state and returns the signing continuation', async () => {
    finalizeConfigAuthorizationWithSignaturesMock.mockResolvedValue({
      status: 'signing_required',
      signingToken: 'opaque-capability',
      redirectTo: 'https://auth.example.com/auth?flow=signatures',
      policyRevision: 7,
    });
    const { finalizeAuthenticatedUser } = await import(
      '../../src/services/access-request-flow.service.js'
    );

    const result = await finalizeAuthenticatedUser({
      userId: 'user-1',
      config,
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback?return=exact',
      rememberMe: false,
      requestAccess: false,
      authMethod: 'github',
      twoFaCompleted: true,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
      ip: '203.0.113.9',
      orgId: 'org-1',
      teamId: 'team-1',
    });

    expect(assertEmailDomainAllowedForLoginMock).toHaveBeenCalledWith({
      userId: 'user-1',
      domain: 'client.example.com',
    });
    expect(assertNotBannedAtLoginMock).toHaveBeenCalledWith({
      userId: 'user-1',
      domain: 'client.example.com',
      ip: '203.0.113.9',
    });
    expect(finalizeConfigAuthorizationWithSignaturesMock).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        domain: 'client.example.com',
        configUrl: 'https://client.example.com/auth-config',
        redirectUrl: 'https://client.example.com/oauth/callback?return=exact',
        codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        codeChallengeMethod: 'S256',
        rememberMe: false,
        requestAccess: false,
        orgId: 'org-1',
        teamId: 'team-1',
        authMethod: 'github',
        twoFaCompleted: true,
      },
      undefined,
    );
    expect(result).toEqual({
      status: 'signing_required',
      signingToken: 'opaque-capability',
      redirectTo: 'https://auth.example.com/auth?flow=signatures',
    });
  });

  it('does not create a continuation when an access request is still pending', async () => {
    handlePostAuthenticationAccessRequestMock.mockResolvedValue({ status: 'requested' });
    const { finalizeAuthenticatedUser } = await import(
      '../../src/services/access-request-flow.service.js'
    );

    const result = await finalizeAuthenticatedUser({
      userId: 'user-1',
      config,
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      rememberMe: true,
      requestAccess: true,
      authMethod: 'email_code',
      twoFaCompleted: false,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
    });

    expect(result.status).toBe('requested');
    expect(finalizeConfigAuthorizationWithSignaturesMock).not.toHaveBeenCalled();
  });
});
