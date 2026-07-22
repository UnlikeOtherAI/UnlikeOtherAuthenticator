import type { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { exchangeConfidentialChainedAccessToken } from '../../src/services/confidential-chained-token-exchange.service.js';
import {
  resetAccessTokenKeyCache,
  type ConfidentialAccessTokenClaims,
} from '../../src/services/oauth/access-token.service.js';

const issuer = 'https://authentication.unlikeotherai.com';
const sourceDomain = 'api.nessie.works';
const callerDomain = 'api.deepsignal.live';
const callerAudience = `https://${callerDomain}`;
const ledgerResource = 'https://ledger.unlikeotherai.com';
const userId = 'usr_1';

let privateKey: KeyLike;
let privateJwk: JWK;
let keyId: string;

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function config(): ClientConfig {
  return {
    domain: callerDomain,
    org_features: { enabled: true, groups_enabled: false },
  } as unknown as ClientConfig;
}

function defaultOrg() {
  return {
    org_id: 'org_1',
    org_role: 'member',
    teams: ['team_1', 'team_2'],
    team_roles: { team_1: 'member', team_2: 'admin' },
  };
}

async function signInboundToken(
  overrides: {
    actor?: unknown;
    audience?: string;
    expiresInSeconds?: number;
    issuer?: string;
    omitActive?: boolean;
    omitOrg?: boolean;
    org?: unknown;
    product?: string;
    scope?: string;
    sourceDomain?: string;
    typ?: string;
    azp?: string;
    credentialEpoch?: number;
    omitCredentialEpoch?: boolean;
  } = {},
): Promise<{ now: number; token: string }> {
  const now = Math.floor(Date.now() / 1000);
  const inboundSource = overrides.sourceDomain ?? sourceDomain;
  const payload: Record<string, unknown> = {
    email: 'nessie-user@example.com',
    source_domain: inboundSource,
    azp: overrides.azp ?? inboundSource,
    product: overrides.product ?? 'nessie',
    scope: overrides.scope ?? 'ai.invoke',
  };
  if (!overrides.omitCredentialEpoch) payload.tv = overrides.credentialEpoch ?? 0;
  if (!overrides.omitOrg) {
    payload.org = Object.prototype.hasOwnProperty.call(overrides, 'org')
      ? overrides.org
      : defaultOrg();
  }
  if (!overrides.omitActive) {
    payload.active = { orgId: 'org_1', teamId: 'team_1' };
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'actor')) {
    payload.act = overrides.actor;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({
      alg: 'RS256',
      kid: keyId,
      typ: overrides.typ ?? 'at+jwt',
    })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? callerAudience)
    .setSubject(userId)
    .setJti('uoa-inbound-jti')
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 240))
    .sign(privateKey);

  return { now, token };
}

function prismaMock(options?: {
  domainRoleExists?: boolean;
  orgExists?: boolean;
  teams?: Array<{ teamId: string; teamRole: string }>;
  userExists?: boolean;
  tokenVersion?: number;
}): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({ domain: callerDomain, status: 'active' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(
        options?.userExists === false
          ? null
          : {
              email: 'current-user@example.com',
              tokenVersion: options?.tokenVersion ?? 0,
              twoFaEnabled: false,
            },
      ),
    },
    domainRole: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options?.domainRoleExists === false ? null : { role: 'USER' }),
    },
    orgMember: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options?.orgExists === false ? null : { orgId: 'org_1', role: 'admin' }),
    },
    teamMember: {
      findMany: vi.fn().mockResolvedValue(
        options?.teams ?? [
          { teamId: 'team_1', teamRole: 'admin' },
          { teamId: 'team_3', teamRole: 'member' },
        ],
      ),
    },
    groupMember: {
      findMany: vi.fn(),
    },
    confidentialAssertionUse: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as PrismaClient;
}

function resolveDelegation(scope = 'ai.invoke') {
  return vi.fn().mockResolvedValue({
    product: 'deepsignal',
    resource: ledgerResource,
    scope,
  });
}

function resolveSourceDelegation() {
  return vi.fn().mockResolvedValue({
    product: 'nessie',
    resource: callerAudience,
    scope: 'ai.invoke',
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  privateJwk = await exportJWK(pair.privateKey);
  keyId = 'uoa-chained-exchange-test';
  Object.assign(privateJwk, { kid: keyId, alg: 'RS256', use: 'sig' });
});

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/authenticator-test';
  process.env.PUBLIC_BASE_URL = issuer;
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
  resetAccessTokenKeyCache();
});

afterAll(() => {
  restoreEnv('DATABASE_URL');
  restoreEnv('PUBLIC_BASE_URL');
  restoreEnv('MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
  resetAccessTokenKeyCache();
});

describe('chained confidential exchange', () => {
  it('narrows a reusable inbound token, caps expiry, and preserves the upstream actor', async () => {
    const { now, token } = await signInboundToken({ expiresInSeconds: 120 });
    const prisma = prismaMock();
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');
    const sourceResolver = resolveSourceDelegation();
    const deps = {
      prisma,
      now: () => now,
      signAccessToken,
      resolveDelegation: resolveDelegation(),
      resolveSourceDelegation: sourceResolver,
      consumeSubjectRateLimit: vi.fn(),
    };
    const input = {
      authenticatedClientDomainId: 'client-domain-deepsignal',
      subjectToken: token,
      product: 'deepsignal',
      resource: ledgerResource,
      scope: 'ai.invoke',
      config: config(),
    };

    await expect(exchangeConfidentialChainedAccessToken(input, deps)).resolves.toEqual({
      accessToken: 'ledger-access-token',
      expiresInSeconds: 120,
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'ai.invoke',
    });
    await expect(exchangeConfidentialChainedAccessToken(input, deps)).resolves.toMatchObject({
      accessToken: 'ledger-access-token',
      expiresInSeconds: 120,
    });

    expect(sourceResolver).toHaveBeenCalledWith(
      {
        sourceDomain,
        product: 'nessie',
        resource: callerAudience,
        scope: 'ai.invoke',
      },
      { prisma },
    );
    const claims = signAccessToken.mock.calls[0]?.[0] as ConfidentialAccessTokenClaims;
    expect(claims).toMatchObject({
      subject: userId,
      credentialEpoch: 0,
      email: 'current-user@example.com',
      sourceDomain: callerDomain,
      product: 'deepsignal',
      resource: ledgerResource,
      issuer,
      ttlSeconds: 120,
      expiresAtEpochSeconds: now + 120,
      scope: 'ai.invoke',
      org: {
        org_id: 'org_1',
        org_role: 'admin',
        teams: ['team_1'],
        team_roles: { team_1: 'admin' },
      },
      active: { orgId: 'org_1', teamId: 'team_1' },
      actor: { sub: sourceDomain, product: 'nessie' },
    });
    expect(claims).not.toHaveProperty('clientId');
    expect(prisma.confidentialAssertionUse.create).not.toHaveBeenCalled();
    expect(prisma.confidentialAssertionUse.deleteMany).not.toHaveBeenCalled();
    expect(signAccessToken).toHaveBeenCalledTimes(2);
  });

  it('rejects a pre-reset chained token whose credential epoch is no longer current', async () => {
    const { now, token } = await signInboundToken({ credentialEpoch: 0 });
    const prisma = prismaMock({ tokenVersion: 1 });

    await expect(
      exchangeConfidentialChainedAccessToken(
        {
          authenticatedClientDomainId: 'client-domain-deepsignal',
          subjectToken: token,
          product: 'deepsignal',
          resource: ledgerResource,
          scope: 'ai.invoke',
          config: config(),
        },
        {
          prisma,
          now: () => now,
          signAccessToken: vi.fn(),
          resolveDelegation: resolveDelegation(),
          resolveSourceDelegation: resolveSourceDelegation(),
          consumeSubjectRateLimit: vi.fn(),
        },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  });

  it('rejects a chained token without tv even when the live epoch is zero', async () => {
    const { now, token } = await signInboundToken({ omitCredentialEpoch: true });
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');
    const input = {
      authenticatedClientDomainId: 'client-domain-deepsignal',
      subjectToken: token,
      product: 'deepsignal',
      resource: ledgerResource,
      scope: 'ai.invoke',
      config: config(),
    };

    await expect(
      exchangeConfidentialChainedAccessToken(input, {
        prisma: prismaMock({ tokenVersion: 0 }),
        now: () => now,
        signAccessToken,
        resolveDelegation: resolveDelegation(),
        resolveSourceDelegation: resolveSourceDelegation(),
        consumeSubjectRateLimit: vi.fn(),
      }),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    expect(signAccessToken).not.toHaveBeenCalled();
  });

  it('retains the full signed upstream chain when another product delegates onward', async () => {
    const upstream = { sub: 'api.origin.example', product: 'origin' };
    const { now, token } = await signInboundToken({ actor: upstream });
    const signAccessToken = vi.fn().mockResolvedValue('ledger-access-token');
    const prisma = prismaMock();

    await exchangeConfidentialChainedAccessToken(
      {
        authenticatedClientDomainId: 'client-domain-deepsignal',
        subjectToken: token,
        product: 'deepsignal',
        resource: ledgerResource,
        scope: 'ai.invoke',
        config: config(),
      },
      {
        prisma,
        now: () => now,
        signAccessToken,
        resolveDelegation: resolveDelegation(),
        resolveSourceDelegation: resolveSourceDelegation(),
        consumeSubjectRateLimit: vi.fn(),
      },
    );

    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          sub: sourceDomain,
          product: 'nessie',
          act: upstream,
        },
      }),
    );
    expect(prisma.domainRole.findUnique).toHaveBeenCalledWith({
      where: {
        domain_userId: {
          domain: upstream.sub,
          userId,
        },
      },
      select: { role: true },
    });
    expect(prisma.orgMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId,
          org: { domain: upstream.sub },
        }),
      }),
    );
  });

  it('rejects scope widening beyond either the inbound token or caller mapping', async () => {
    const { now, token } = await signInboundToken();
    const signAccessToken = vi.fn();

    await expect(
      exchangeConfidentialChainedAccessToken(
        {
          authenticatedClientDomainId: 'client-domain-deepsignal',
          subjectToken: token,
          product: 'deepsignal',
          resource: ledgerResource,
          scope: 'billing.read',
          config: config(),
        },
        {
          prisma: prismaMock(),
          now: () => now,
          signAccessToken,
          resolveDelegation: resolveDelegation('billing.read'),
          resolveSourceDelegation: resolveSourceDelegation(),
          consumeSubjectRateLimit: vi.fn(),
        },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
    expect(signAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed when the original product link, user link, or selected team is revoked', async () => {
    const { now, token } = await signInboundToken();
    const cases = [
      {
        prisma: prismaMock(),
        sourceResolver: vi.fn().mockRejectedValue(new Error('mapping disabled')),
      },
      {
        prisma: prismaMock({ domainRoleExists: false }),
        sourceResolver: resolveSourceDelegation(),
      },
      {
        prisma: prismaMock({ teams: [{ teamId: 'team_2', teamRole: 'member' }] }),
        sourceResolver: resolveSourceDelegation(),
      },
    ];

    for (const testCase of cases) {
      const signAccessToken = vi.fn();
      await expect(
        exchangeConfidentialChainedAccessToken(
          {
            authenticatedClientDomainId: 'client-domain-deepsignal',
            subjectToken: token,
            product: 'deepsignal',
            resource: ledgerResource,
            scope: 'ai.invoke',
            config: config(),
          },
          {
            prisma: testCase.prisma,
            now: () => now,
            signAccessToken,
            resolveDelegation: resolveDelegation(),
            resolveSourceDelegation: testCase.sourceResolver,
            consumeSubjectRateLimit: vi.fn(),
          },
        ),
      ).rejects.toThrow();
      expect(signAccessToken).not.toHaveBeenCalled();
    }
  });
});
