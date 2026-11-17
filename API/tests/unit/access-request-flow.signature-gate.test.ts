import { legacyCredentialStores } from '../helpers/authentication-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';

const assertEmailDomainAllowedForLoginMock = vi.fn();
const assertNotBannedAtLoginMock = vi.fn();
const handlePostAuthenticationAccessRequestMock = vi.fn();
const finalizeConfigAuthorizationWithSignaturesMock = vi.fn();
const resolveTeamByIdMock = vi.fn();

vi.mock('../../src/services/team-hostname.service.js', () => ({
  resolveTeamById: (...args: unknown[]) => resolveTeamByIdMock(...args),
}));

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
    resolveTeamByIdMock.mockReset();
  });

  it('binds a team sign-in to the team address when the config declares a template', async () => {
    const prisma = legacyCredentialStores() as unknown as PrismaClient;
    resolveTeamByIdMock.mockResolvedValue({
      teamId: 'team-1',
      teamSlug: 'design',
      orgId: 'org-1',
      orgSlug: 'acme',
    });
    finalizeConfigAuthorizationWithSignaturesMock.mockResolvedValue({
      status: 'granted',
      code: 'code-1',
      redirectTo: 'https://acme.client.example.com/design/login?code=code-1',
    });
    const { finalizeAuthenticatedUser } =
      await import('../../src/services/access-request-flow.service.js');
    const input = {
      userId: 'user-1',
      credentialEpoch: 0,
      config: {
        ...config,
        login_flow: {
          team_redirect: {
            redirect_url: 'https://client.example.com/oauth/callback',
            template: 'https://{org}.client.example.com/{team}/login',
          },
        },
      } as ClientConfig,
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      rememberMe: false,
      requestAccess: false,
      authMethod: 'google',
      twoFaCompleted: false,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256' as const,
      orgId: 'org-1',
      teamId: 'team-1',
    };

    await finalizeAuthenticatedUser(input, { authenticationEpochLocked: true, prisma });

    expect(resolveTeamByIdMock).toHaveBeenCalledWith(
      { domain: 'client.example.com', teamId: 'team-1' },
      { prisma },
    );
    expect(finalizeConfigAuthorizationWithSignaturesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ redirectUrl: 'https://acme.client.example.com/design/login' }),
      expect.anything(),
    );

    // A machine approval finishes on UOA's own pages, never at a team address.
    await finalizeAuthenticatedUser(
      { ...input, machineIntentId: 'machine-1' },
      { authenticationEpochLocked: true, prisma },
    );
    expect(resolveTeamByIdMock).toHaveBeenCalledTimes(1);
    expect(finalizeConfigAuthorizationWithSignaturesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ redirectUrl: 'https://client.example.com/oauth/callback' }),
      expect.anything(),
    );
  });

  it('forwards the exact authenticated flow state and returns the signing continuation', async () => {
    const prisma = legacyCredentialStores() as unknown as PrismaClient;
    finalizeConfigAuthorizationWithSignaturesMock.mockResolvedValue({
      status: 'signing_required',
      signingToken: 'opaque-capability',
      redirectTo: 'https://auth.example.com/auth?flow=signatures',
      policyRevision: 7,
    });
    const { finalizeAuthenticatedUser } =
      await import('../../src/services/access-request-flow.service.js');

    const result = await finalizeAuthenticatedUser(
      {
        userId: 'user-1',
        credentialEpoch: 0,
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
      },
      { authenticationEpochLocked: true, prisma },
    );

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
        credentialEpoch: 0,
      },
      { prisma, teamPrisma: prisma },
    );
    expect(result).toEqual({
      status: 'signing_required',
      signingToken: 'opaque-capability',
      redirectTo: 'https://auth.example.com/auth?flow=signatures',
    });
  });

  it('does not create a continuation when an access request is still pending', async () => {
    const prisma = legacyCredentialStores() as unknown as PrismaClient;
    handlePostAuthenticationAccessRequestMock.mockResolvedValue({ status: 'requested' });
    const { finalizeAuthenticatedUser } =
      await import('../../src/services/access-request-flow.service.js');

    const result = await finalizeAuthenticatedUser(
      {
        userId: 'user-1',
        credentialEpoch: 0,
        config,
        configUrl: 'https://client.example.com/auth-config',
        redirectUrl: 'https://client.example.com/oauth/callback',
        rememberMe: true,
        requestAccess: true,
        authMethod: 'email_code',
        twoFaCompleted: false,
        codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        codeChallengeMethod: 'S256',
      },
      { authenticationEpochLocked: true, prisma },
    );

    expect(result.status).toBe('requested');
    expect(finalizeConfigAuthorizationWithSignaturesMock).not.toHaveBeenCalled();
  });

  it('keeps signature team decisions on the authoritative outer transaction', async () => {
    const outerPrisma = legacyCredentialStores() as unknown as PrismaClient;
    const detachedTeamPrisma = { detached: true } as unknown as PrismaClient;
    finalizeConfigAuthorizationWithSignaturesMock.mockResolvedValue({
      status: 'granted',
      code: 'code-1',
      redirectTo: 'https://client.example.com/oauth/callback?code=code-1',
    });
    const { finalizeAuthenticatedUser } =
      await import('../../src/services/access-request-flow.service.js');

    await finalizeAuthenticatedUser(
      {
        userId: 'user-1',
        credentialEpoch: 0,
        config,
        configUrl: 'https://client.example.com/auth-config',
        redirectUrl: 'https://client.example.com/oauth/callback',
        rememberMe: true,
        requestAccess: false,
        authMethod: 'email_password',
        twoFaCompleted: true,
        codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        codeChallengeMethod: 'S256',
        orgId: 'org-1',
        teamId: 'team-1',
      },
      {
        authenticationEpochLocked: true,
        prisma: outerPrisma,
        teamPrisma: detachedTeamPrisma,
      },
    );

    expect(finalizeConfigAuthorizationWithSignaturesMock).toHaveBeenCalledWith(expect.any(Object), {
      prisma: outerPrisma,
      teamPrisma: outerPrisma,
    });
  });
});
