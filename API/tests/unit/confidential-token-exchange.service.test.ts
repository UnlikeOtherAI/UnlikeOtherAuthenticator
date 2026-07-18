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
  CONFIDENTIAL_TOKEN_EXCHANGE_SOURCE_DOMAIN: process.env.CONFIDENTIAL_TOKEN_EXCHANGE_SOURCE_DOMAIN,
  CONFIDENTIAL_TOKEN_EXCHANGE_RESOURCE: process.env.CONFIDENTIAL_TOKEN_EXCHANGE_RESOURCE,
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
    active?: { orgId: string; teamId: string };
    jti?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    source_domain: overrides.sourceDomain ?? sourceDomain,
    active: overrides.active ?? { orgId: 'org_1', teamId: 'team_1' },
  })
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid!, typ: 'JWT' })
    .setIssuer(sourceDomain)
    .setAudience(overrides.audience ?? audience)
    .setSubject('usr_1')
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 60));
  if (overrides.jti !== '') jwt.setJti(overrides.jti ?? 'assertion_1');
  return await jwt.sign(sourcePrivateKey);
}

function fetchJwks() {
  return vi.fn().mockResolvedValue({ keys: [sourcePublicJwk] });
}

function prismaMock(options?: { activeTeam?: boolean }): PrismaClient {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: 'nessie-user@example.com' }),
    },
    domainRole: {
      findUnique: vi.fn().mockResolvedValue({ role: 'USER' }),
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
  process.env.CONFIDENTIAL_TOKEN_EXCHANGE_SOURCE_DOMAIN = sourceDomain;
  process.env.CONFIDENTIAL_TOKEN_EXCHANGE_RESOURCE = resource;
});

afterAll(() => {
  restoreEnv('DATABASE_URL');
  restoreEnv('PUBLIC_BASE_URL');
  restoreEnv('SHARED_SECRET');
  restoreEnv('MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
  restoreEnv('CONFIDENTIAL_TOKEN_EXCHANGE_SOURCE_DOMAIN');
  restoreEnv('CONFIDENTIAL_TOKEN_EXCHANGE_RESOURCE');
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

  it('rejects a subject assertion whose lifetime exceeds five minutes', async () => {
    const token = await signSubjectToken({ expiresInSeconds: 301 });
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
  it('re-resolves the user and selected workspace before signing', async () => {
    const subjectToken = await signSubjectToken();
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');

    const result = await exchangeConfidentialSubjectToken(
      {
        subjectToken,
        resource,
        config: config(),
        configJwt,
      },
      {
        prisma: prismaMock(),
        fetchJwks: fetchJwks(),
        signAccessToken,
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
  });

  it('rejects an assertion when its selected team membership is no longer active', async () => {
    await expect(
      exchangeConfidentialSubjectToken(
        {
          subjectToken: await signSubjectToken(),
          resource,
          config: config(),
          configJwt,
        },
        {
          prisma: prismaMock({ activeTeam: false }),
          fetchJwks: fetchJwks(),
          signAccessToken: vi.fn(),
        },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  });

  it('enforces the exact configured source-to-resource mapping', async () => {
    await expect(
      exchangeConfidentialSubjectToken(
        {
          subjectToken: await signSubjectToken(),
          resource: `${resource}/other`,
          config: config(),
          configJwt,
        },
        { prisma: prismaMock(), fetchJwks: fetchJwks() },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_TARGET_NOT_ALLOWED');
  });
});
