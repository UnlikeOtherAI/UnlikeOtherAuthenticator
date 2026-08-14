import type { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { exchangeConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import type { ConfidentialAccessTokenClaims } from '../../src/services/oauth/access-token.service.js';

const sourceDomain = 'api.nessie.works';
const clientDomainId = 'client-domain-nessie';
const ordinaryProduct = 'nessie';
const ledgerResource = 'https://ledger.unlikeotherai.com';
// Exact production privileged binding: the pinned `nessie-identity` product on
// the identity/membership API audience (see PRIVILEGED_IDENTITY_MEMBERSHIP_PIN).
const privilegedProduct = 'nessie-identity';
const identityMembershipResource = 'https://authentication.unlikeotherai.com';
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

async function signSubjectToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ source_domain: sourceDomain, tv: 0 })
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid!, typ: 'JWT' })
    .setIssuer(sourceDomain)
    .setAudience(audience)
    .setSubject('usr_1')
    .setIssuedAt(now)
    .setExpirationTime(now + 60);
  jwt.setJti('assertion_1');
  return await jwt.sign(sourcePrivateKey);
}

function fetchJwks() {
  return vi.fn().mockResolvedValue({ keys: [sourcePublicJwk] });
}

function prismaMock(): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({ domain: sourceDomain, status: 'active' }),
    },
    billingAppKey: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        email: 'nessie-user@example.com',
        tokenVersion: 0,
        twoFaEnabled: false,
      }),
    },
    domainRole: {
      findUnique: vi.fn().mockResolvedValue({ role: 'USER' }),
    },
    confidentialAssertionUse: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'assertion-use-1' }),
    },
    orgMember: {
      findFirst: vi.fn().mockResolvedValue({
        orgId: 'org_1',
        role: 'member',
        org: { slug: 'nessie' },
      }),
    },
    teamMember: {
      findMany: vi.fn().mockResolvedValue([{ teamId: 'team_1', teamRole: 'member' }]),
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

describe('confidential token exchange email claim scoping', () => {
  it('omits the advisory email claim for the pinned nessie-identity privileged binding', async () => {
    const signAccessToken = vi.fn().mockResolvedValue('identity-api-token');
    const resolveDelegation = vi.fn().mockResolvedValue({
      product: privilegedProduct,
      resource: identityMembershipResource,
      scope: 'identity.read membership.manage',
    });

    const result = await exchangeConfidentialSubjectToken(
      {
        authenticatedClientDomainId: clientDomainId,
        subjectToken: await signSubjectToken(),
        product: privilegedProduct,
        resource: identityMembershipResource,
        scope: 'identity.read membership.manage',
        config: config(),
        configJwt,
      },
      {
        prisma: prismaMock(),
        fetchJwks: fetchJwks(),
        signAccessToken,
        consumeSubjectRateLimit: vi.fn(),
        resolveDelegation,
      },
    );

    expect(result).toMatchObject({ scope: 'identity.read membership.manage' });
    const claims = signAccessToken.mock.calls[0]?.[0] as ConfidentialAccessTokenClaims;
    expect(claims).not.toHaveProperty('email');
    expect(claims).toMatchObject({
      subject: 'usr_1',
      credentialEpoch: 0,
      sourceDomain,
      product: privilegedProduct,
      resource: identityMembershipResource,
      scope: 'identity.read membership.manage',
    });
  });

  it('keeps the advisory email claim for ai.invoke and billing.read scopes', async () => {
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');
    const resolveDelegation = vi.fn().mockResolvedValue({
      product: ordinaryProduct,
      resource: ledgerResource,
      scope: 'ai.invoke billing.read',
    });

    await expect(
      exchangeConfidentialSubjectToken(
        {
          authenticatedClientDomainId: clientDomainId,
          subjectToken: await signSubjectToken(),
          product: ordinaryProduct,
          resource: ledgerResource,
          scope: 'ai.invoke billing.read',
          config: config(),
          configJwt,
        },
        {
          prisma: prismaMock(),
          fetchJwks: fetchJwks(),
          signAccessToken,
          consumeSubjectRateLimit: vi.fn(),
          resolveDelegation,
        },
      ),
    ).resolves.toMatchObject({ accessToken: 'ledger-access-token' });

    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nessie-user@example.com',
        product: ordinaryProduct,
        resource: ledgerResource,
      }),
    );
  });
});
