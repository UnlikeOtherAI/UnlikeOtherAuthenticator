import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import {
  completeSigningContinuation,
  finalizeConfigAuthorizationWithSignatures,
  finalizePublicOAuthAuthorizationWithSignatures,
  hashSigningContinuationToken,
} from '../../src/services/signature-continuation.service.js';
import { evaluateSignaturePolicy } from '../../src/services/signature-policy.service.js';

vi.mock('../../src/services/signature-policy.service.js', () => ({
  evaluateSignaturePolicy: vi.fn(),
}));

const SHARED_SECRET = 'test-shared-secret-that-is-at-least-thirty-two-bytes';
const NOW = new Date('2026-07-15T20:00:00.000Z');
const env = parseEnv({ NODE_ENV: 'test', SHARED_SECRET });

function continuation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'continuation-1',
    tokenHash: hashSigningContinuationToken('signing-token', SHARED_SECRET),
    userId: 'user-1',
    domain: 'client.example.com',
    authProfile: 'CONFIG_JWT',
    configUrl: 'https://client.example.com/config',
    redirectUrl: 'https://client.example.com/callback',
    oauthState: null,
    oauthClientId: null,
    oauthScope: null,
    resource: null,
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    rememberMe: true,
    requestAccess: false,
    orgId: 'org-1',
    teamId: 'team-1',
    authMethod: 'email_password',
    twoFaCompleted: true,
    policyRevision: 3,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    consumedAt: null,
    attemptCount: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function fakePrisma(existing: ReturnType<typeof continuation> | null = null) {
  let row = existing;
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
    signingContinuation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = continuation({ id: 'created-continuation', ...data });
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
        row?.tokenHash === where.tokenHash ? row : null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (!row || row.id !== where.id || row.consumedAt) return { count: 0 };
        if ('consumedAt' in data) row.consumedAt = data.consumedAt as Date;
        return { count: 1 };
      }),
    },
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return prisma;
}

const configInput = {
  userId: 'user-1',
  domain: 'Client.Example.COM',
  configUrl: 'https://client.example.com/config',
  redirectUrl: 'https://client.example.com/callback',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256' as const,
  rememberMe: true,
  requestAccess: false,
  orgId: 'org-1',
  teamId: 'team-1',
  authMethod: 'email_password',
  twoFaCompleted: true,
};

describe('signature authorization gate', () => {
  beforeEach(() => {
    vi.mocked(evaluateSignaturePolicy).mockReset();
  });

  it('keeps disabled/complete domains on the existing authorization-code path', async () => {
    const prisma = fakePrisma();
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue({
      enabled: false,
      complete: true,
      policyRevision: 0,
      required: [],
      missing: [],
    });
    const issueConfigCode = vi.fn().mockResolvedValue({ code: 'authorization-code' });

    await expect(
      finalizeConfigAuthorizationWithSignatures(configInput, {
        env,
        prisma: prisma as never,
        sharedSecret: SHARED_SECRET,
        now: () => NOW,
        issueConfigCode,
      }),
    ).resolves.toEqual({
      status: 'granted',
      code: 'authorization-code',
      redirectTo: 'https://client.example.com/callback?code=authorization-code',
    });
    expect(prisma.signingContinuation.create).not.toHaveBeenCalled();
    expect(issueConfigCode).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'client.example.com', codeChallengeMethod: 'S256' }),
      expect.objectContaining({ prisma }),
    );
  });

  it('stores an exact-flow continuation with only a keyed token hash', async () => {
    const prisma = fakePrisma();
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue({
      enabled: true,
      complete: false,
      policyRevision: 7,
      required: [],
      missing: [],
    });
    const result = await finalizeConfigAuthorizationWithSignatures(configInput, {
      env,
      prisma: prisma as never,
      sharedSecret: SHARED_SECRET,
      publicBaseUrl: 'https://auth.example.com',
      now: () => NOW,
      issueConfigCode: vi.fn(),
    });

    expect(result.status).toBe('signing_required');
    if (result.status !== 'signing_required') throw new Error('unexpected outcome');
    expect(result.redirectTo).toContain('https://auth.example.com/auth?');
    expect(result.redirectTo).toContain(`signing_token=${encodeURIComponent(result.signingToken)}`);
    const data = prisma.signingContinuation.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      userId: 'user-1',
      domain: 'client.example.com',
      authProfile: 'CONFIG_JWT',
      configUrl: configInput.configUrl,
      redirectUrl: configInput.redirectUrl,
      orgId: 'org-1',
      teamId: 'team-1',
      authMethod: 'email_password',
      twoFaCompleted: true,
      policyRevision: 7,
    });
    expect(data.tokenHash).toBe(hashSigningContinuationToken(result.signingToken, SHARED_SECRET));
    expect(JSON.stringify(data)).not.toContain(result.signingToken);
  });

  it('preserves public OAuth client, state, resource, scope, and PKCE state', async () => {
    const prisma = fakePrisma();
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue({
      enabled: true,
      complete: false,
      policyRevision: 2,
      required: [],
      missing: [],
    });
    const result = await finalizePublicOAuthAuthorizationWithSignatures(
      {
        userId: 'user-1',
        domain: 'mcp.example.com',
        oauthClientId: 'oauth-client-1',
        redirectUrl: 'https://tool.example/callback',
        resource: 'https://resource.example',
        state: 'opaque-state',
        scope: 'openid profile',
        codeChallenge: 'challenge',
        rememberMe: false,
        authMethod: 'email_password',
        twoFaCompleted: false,
      },
      {
        env,
        prisma: prisma as never,
        sharedSecret: SHARED_SECRET,
        publicBaseUrl: 'https://auth.example.com',
        now: () => NOW,
        issuePublicCode: vi.fn() as never,
      },
    );
    expect(result.status).toBe('signing_required');
    if (result.status !== 'signing_required') throw new Error('unexpected outcome');
    const url = new URL(result.redirectTo);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('oauth-client-1');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('resource')).toBe('https://resource.example');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(prisma.signingContinuation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authProfile: 'PUBLIC_OAUTH',
        oauthClientId: 'oauth-client-1',
        oauthState: 'opaque-state',
        oauthScope: 'openid profile',
        configUrl: null,
      }),
    });
  });
});

describe('signing continuation completion', () => {
  beforeEach(() => {
    vi.mocked(evaluateSignaturePolicy).mockReset();
  });

  it('re-evaluates and refuses to consume when a requirement is still missing', async () => {
    const prisma = fakePrisma(continuation());
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue({
      enabled: true,
      complete: false,
      policyRevision: 4,
      required: [],
      missing: [],
    });
    const issueConfigCode = vi.fn();
    const result = await completeSigningContinuation('signing-token', {
      env,
      prisma: prisma as never,
      sharedSecret: SHARED_SECRET,
      publicBaseUrl: 'https://auth.example.com',
      now: () => NOW,
      issueConfigCode,
    });
    expect(result).toMatchObject({ status: 'signing_required', policyRevision: 4 });
    expect(prisma.signingContinuation.updateMany).not.toHaveBeenCalled();
    expect(issueConfigCode).not.toHaveBeenCalled();
  });

  it('atomically consumes once and creates the authorization code after a final current-policy check', async () => {
    const prisma = fakePrisma(continuation());
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue({
      enabled: true,
      complete: true,
      policyRevision: 4,
      required: [],
      missing: [],
    });
    const issueConfigCode = vi.fn().mockResolvedValue({ code: 'authorization-code' });
    await expect(
      completeSigningContinuation('signing-token', {
        env,
        prisma: prisma as never,
        sharedSecret: SHARED_SECRET,
        now: () => NOW,
        issueConfigCode,
      }),
    ).resolves.toMatchObject({ status: 'granted', code: 'authorization-code' });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.signingContinuation.updateMany).toHaveBeenCalledWith({
      where: { id: 'continuation-1', consumedAt: null, expiresAt: { gt: NOW } },
      data: { consumedAt: NOW },
    });
    await expect(
      completeSigningContinuation('signing-token', {
        env,
        prisma: prisma as never,
        sharedSecret: SHARED_SECRET,
        now: () => NOW,
        issueConfigCode,
      }),
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
    expect(issueConfigCode).toHaveBeenCalledOnce();
  });

  it('rejects invalid, expired, consumed, and attempt-exhausted capabilities identically', async () => {
    for (const row of [
      null,
      continuation({ expiresAt: NOW }),
      continuation({ consumedAt: NOW }),
      continuation({ attemptCount: env.SIGNATURE_MAX_SIGN_ATTEMPTS }),
    ]) {
      const prisma = fakePrisma(row);
      await expect(
        completeSigningContinuation('signing-token', {
          env,
          prisma: prisma as never,
          sharedSecret: SHARED_SECRET,
          now: () => NOW,
          issueConfigCode: vi.fn(),
        }),
      ).rejects.toMatchObject({ statusCode: 401, message: 'AUTHENTICATION_FAILED' });
    }
  });
});
