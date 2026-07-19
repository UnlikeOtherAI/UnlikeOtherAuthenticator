import type { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  exchangeConfidentialSubjectToken,
  verifyConfidentialSubjectToken,
} from '../../src/services/confidential-token-exchange.service.js';
import type { ConfidentialAccessTokenClaims } from '../../src/services/oauth/access-token.service.js';

const sourceDomain = 'api.nessie.works';
const clientDomainId = 'client-domain-nessie';
const product = 'nessie';
const resource = 'https://ledger.unlikeotherai.com';
const audience = 'https://authentication.unlikeotherai.com/auth/token';
const jwksUrl = `https://${sourceDomain}/.well-known/jwks.json`;

let sourcePrivateKey: KeyLike;
let sourcePublicJwk: JWK;
let configJwt: string;

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  SHARED_SECRET: process.env.SHARED_SECRET,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function config(): ClientConfig {
  return {
    domain: sourceDomain,
    org_features: {
      enabled: true,
      groups_enabled: false,
    },
  } as unknown as ClientConfig;
}

async function signSubjectToken(
  overrides: {
    audience?: string;
    expiresInSeconds?: number;
    sourceDomain?: string;
    subject?: string;
    active?: unknown;
    omitActive?: boolean;
    jti?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    source_domain: overrides.sourceDomain ?? sourceDomain,
  };
  if (!overrides.omitActive) {
    payload.active = Object.prototype.hasOwnProperty.call(overrides, 'active')
      ? overrides.active
      : { orgId: 'org_1', teamId: 'team_1' };
  }
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid!, typ: 'JWT' })
    .setIssuer(sourceDomain)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? 'usr_1')
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 60));
  if (overrides.jti !== '') jwt.setJti(overrides.jti ?? 'assertion_1');
  return await jwt.sign(sourcePrivateKey);
}

function fetchJwks() {
  return vi.fn().mockResolvedValue({ keys: [sourcePublicJwk] });
}

function resolveDelegation() {
  return vi.fn().mockResolvedValue({ product, resource, scope: 'ai.invoke' });
}

function exchangeInput(subjectToken: string) {
  return {
    authenticatedClientDomainId: clientDomainId,
    subjectToken,
    product,
    resource,
    scope: 'ai.invoke',
    config: config(),
    configJwt,
  };
}

function prismaMock(options?: {
  activeTeam?: boolean;
  domainRoleExists?: boolean;
  userExists?: boolean;
}): PrismaClient {
  return {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options?.userExists === false ? null : { email: 'nessie-user@example.com' },
        ),
    },
    domainRole: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options?.domainRoleExists === false ? null : { role: 'USER' }),
    },
    confidentialAssertionUse: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'assertion-use-1' }),
    },
    orgMember: {
      findFirst: vi.fn().mockResolvedValue({ orgId: 'org_1', role: 'member' }),
    },
    teamMember: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options?.activeTeam === false ? [] : [{ teamId: 'team_1', teamRole: 'member' }],
        ),
    },
    groupMember: {
      findMany: vi.fn(),
    },
  } as unknown as PrismaClient;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  sourcePrivateKey = pair.privateKey;
  sourcePublicJwk = await exportJWK(pair.publicKey);
  sourcePublicJwk.kid = 'nessie-subject-key';
  sourcePublicJwk.alg = 'RS256';
  sourcePublicJwk.use = 'sig';
  configJwt = await new SignJWT({ domain: sourceDomain, jwks_url: jwksUrl })
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid })
    .sign(sourcePrivateKey);
});

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/authenticator-test';
  process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = '{}';
});

afterAll(() => {
  restoreEnv('DATABASE_URL');
  restoreEnv('PUBLIC_BASE_URL');
  restoreEnv('SHARED_SECRET');
  restoreEnv('MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
});

describe('confidential subject-token verification', () => {
  it('verifies the assertion with the JWKS published by the source config', async () => {
    const fetcher = fetchJwks();
    const token = await signSubjectToken();

    const assertion = await verifyConfidentialSubjectToken(
      {
        subjectToken: token,
        configJwt,
        sourceDomain,
        audience,
      },
      { fetchJwks: fetcher },
    );

    expect(assertion.sub).toBe('usr_1');
    expect(assertion.active).toEqual({ orgId: 'org_1', teamId: 'team_1' });
    expect(fetcher).toHaveBeenCalledWith(jwksUrl, {
      expectedHost: sourceDomain,
    });
  });

  it('accepts a signed identity assertion without workspace context', async () => {
    const assertion = await verifyConfidentialSubjectToken(
      {
        subjectToken: await signSubjectToken({ omitActive: true }),
        configJwt,
        sourceDomain,
        audience,
      },
      { fetchJwks: fetchJwks() },
    );

    expect(assertion.sub).toBe('usr_1');
    expect(assertion).not.toHaveProperty('active');
  });

  it('rejects partial or malformed workspace context', async () => {
    const malformedActiveClaims: unknown[] = [
      {},
      { orgId: 'org_1' },
      { teamId: 'team_1' },
      { orgId: '', teamId: 'team_1' },
      { orgId: 'org_1', teamId: '' },
      { orgId: 'org_1', teamId: 'team_1', extra: true },
      null,
    ];

    for (const active of malformedActiveClaims) {
      await expect(
        verifyConfidentialSubjectToken(
          {
            subjectToken: await signSubjectToken({ active }),
            configJwt,
            sourceDomain,
            audience,
          },
          { fetchJwks: fetchJwks() },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }
  });

  it('rejects a subject assertion whose lifetime exceeds 60 seconds', async () => {
    const token = await signSubjectToken({ expiresInSeconds: 61 });
    await expect(
      verifyConfidentialSubjectToken(
        { subjectToken: token, configJwt, sourceDomain, audience },
        { fetchJwks: fetchJwks() },
      ),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });

  it('rejects the wrong source domain, audience, or a missing jti', async () => {
    const wrongSource = await signSubjectToken({ sourceDomain: 'evil.example.com' });
    const wrongAudience = await signSubjectToken({
      audience: 'https://authentication.unlikeotherai.com/oauth/token',
    });
    const noJti = await signSubjectToken({ jti: '' });

    for (const subjectToken of [wrongSource, wrongAudience, noJti]) {
      await expect(
        verifyConfidentialSubjectToken(
          { subjectToken, configJwt, sourceDomain, audience },
          { fetchJwks: fetchJwks() },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }
  });
});

describe('confidential token exchange', () => {
  it('issues an identity-only token when the user has no selected workspace', async () => {
    const prisma = prismaMock();
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');

    await expect(
      exchangeConfidentialSubjectToken(
        {
          authenticatedClientDomainId: clientDomainId,
          subjectToken: await signSubjectToken({ omitActive: true }),
          product,
          resource,
          scope: 'ai.invoke',
          config: config(),
          configJwt,
        },
        {
          prisma,
          fetchJwks: fetchJwks(),
          signAccessToken,
          consumeSubjectRateLimit: vi.fn(),
          resolveDelegation: resolveDelegation(),
        },
      ),
    ).resolves.toMatchObject({ accessToken: 'ledger-access-token' });

    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'usr_1',
        email: 'nessie-user@example.com',
        sourceDomain,
        product,
        resource,
        scope: 'ai.invoke',
      }),
    );
    const claims = signAccessToken.mock.calls[0]?.[0] as ConfidentialAccessTokenClaims;
    expect(claims).not.toHaveProperty('org');
    expect(claims).not.toHaveProperty('active');
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(prisma.confidentialAssertionUse.create).toHaveBeenCalledOnce();
  });

  it('re-resolves the user and selected workspace before signing', async () => {
    const subjectToken = await signSubjectToken();
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');
    const consumeSubjectRateLimit = vi.fn();

    const result = await exchangeConfidentialSubjectToken(
      {
        authenticatedClientDomainId: clientDomainId,
        subjectToken,
        product,
        resource,
        scope: 'ai.invoke',
        config: config(),
        configJwt,
      },
      {
        prisma: prismaMock(),
        fetchJwks: fetchJwks(),
        signAccessToken,
        consumeSubjectRateLimit,
        resolveDelegation: resolveDelegation(),
      },
    );

    expect(result).toEqual({
      accessToken: 'ledger-access-token',
      expiresInSeconds: 300,
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'ai.invoke',
    });
    const claims = signAccessToken.mock.calls[0]?.[0] as ConfidentialAccessTokenClaims;
    expect(claims).toMatchObject({
      subject: 'usr_1',
      email: 'nessie-user@example.com',
      sourceDomain,
      product,
      resource,
      issuer: 'https://authentication.unlikeotherai.com',
      ttlSeconds: 300,
      scope: 'ai.invoke',
      active: { orgId: 'org_1', teamId: 'team_1' },
      org: {
        org_id: 'org_1',
        org_role: 'member',
        teams: ['team_1'],
        team_roles: { team_1: 'member' },
      },
    });
    expect(claims).not.toHaveProperty('clientId');
    expect(consumeSubjectRateLimit).toHaveBeenCalledWith(`${sourceDomain}:usr_1`);
  });

  it('rejects an assertion when its selected team membership is no longer active', async () => {
    const prisma = prismaMock({ activeTeam: false });
    await expect(
      exchangeConfidentialSubjectToken(
        {
          authenticatedClientDomainId: clientDomainId,
          subjectToken: await signSubjectToken(),
          product,
          resource,
          scope: 'ai.invoke',
          config: config(),
          configJwt,
        },
        {
          prisma,
          fetchJwks: fetchJwks(),
          signAccessToken: vi.fn(),
          resolveDelegation: resolveDelegation(),
        },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
    expect(prisma.confidentialAssertionUse.create).not.toHaveBeenCalled();
  });

  it('rejects identity-only assertions for an unknown user or missing source-domain role', async () => {
    for (const prisma of [
      prismaMock({ userExists: false }),
      prismaMock({ domainRoleExists: false }),
    ]) {
      await expect(
        exchangeConfidentialSubjectToken(
          {
            authenticatedClientDomainId: clientDomainId,
            subjectToken: await signSubjectToken({ omitActive: true }),
            product,
            resource,
            scope: 'ai.invoke',
            config: config(),
            configJwt,
          },
          {
            prisma,
            fetchJwks: fetchJwks(),
            signAccessToken: vi.fn(),
            consumeSubjectRateLimit: vi.fn(),
            resolveDelegation: resolveDelegation(),
          },
        ),
      ).rejects.toThrow('TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
      expect(prisma.confidentialAssertionUse.create).not.toHaveBeenCalled();
    }
  });

  it('rejects an exact assertion replay while accepting a fresh jti', async () => {
    const prisma = prismaMock();
    const consumed = new Set<string>();
    vi.mocked(prisma.confidentialAssertionUse.create).mockImplementation(async ({ data }) => {
      const key = `${data.sourceDomain}:${data.jtiHash}`;
      if (consumed.has(key)) {
        throw { code: 'P2002' };
      }
      consumed.add(key);
      return { id: `use-${consumed.size}` };
    });
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');
    const repeatedAssertion = await signSubjectToken({ omitActive: true, jti: 'one-time-jti' });
    const exchange = (subjectToken: string) =>
      exchangeConfidentialSubjectToken(
        {
          authenticatedClientDomainId: clientDomainId,
          subjectToken,
          product,
          resource,
          scope: 'ai.invoke',
          config: config(),
          configJwt,
        },
        {
          prisma,
          fetchJwks: fetchJwks(),
          signAccessToken,
          consumeSubjectRateLimit: vi.fn(),
          resolveDelegation: resolveDelegation(),
        },
      );

    await expect(exchange(repeatedAssertion)).resolves.toMatchObject({
      accessToken: 'ledger-access-token',
    });
    await expect(exchange(repeatedAssertion)).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    await expect(
      exchange(await signSubjectToken({ omitActive: true, jti: 'fresh-jti' })),
    ).resolves.toMatchObject({ accessToken: 'ledger-access-token' });
    expect(signAccessToken).toHaveBeenCalledTimes(2);
  });

  it('rate-limits a verified user without consuming another user’s allowance', async () => {
    const firstUserToken = await signSubjectToken({ subject: 'usr_rate_limited' });
    const secondUserToken = await signSubjectToken({ subject: 'usr_independent' });
    const deps = {
      prisma: prismaMock(),
      fetchJwks: fetchJwks(),
      signAccessToken: vi.fn().mockResolvedValue('ledger-access-token'),
      resolveDelegation: resolveDelegation(),
    };

    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
      await expect(
        exchangeConfidentialSubjectToken(exchangeInput(firstUserToken), deps),
      ).resolves.toMatchObject({ accessToken: 'ledger-access-token' });
    }
    await expect(
      exchangeConfidentialSubjectToken(exchangeInput(firstUserToken), deps),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    await expect(
      exchangeConfidentialSubjectToken(exchangeInput(secondUserToken), deps),
    ).resolves.toMatchObject({ accessToken: 'ledger-access-token' });
  });

  it('fails before assertion verification when DB delegation resolution rejects the target', async () => {
    const rejectDelegation = vi
      .fn()
      .mockRejectedValue(new Error('TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED'));
    const fetcher = fetchJwks();
    await expect(
      exchangeConfidentialSubjectToken(
        {
          authenticatedClientDomainId: clientDomainId,
          subjectToken: await signSubjectToken(),
          product,
          resource: `${resource}/other`,
          scope: 'ai.invoke',
          config: config(),
          configJwt,
        },
        {
          prisma: prismaMock(),
          fetchJwks: fetcher,
          resolveDelegation: rejectDelegation,
        },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
