import { ConfidentialDelegationScope, type PrismaClient } from '@prisma/client';
import { decodeJwt, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeConfidentialChainedAccessToken,
  verifyChainedSubjectAccessToken,
} from '../../src/services/confidential-chained-token-exchange.service.js';
import { exchangeConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import { resolveConfidentialDelegation } from '../../src/services/confidential-delegation.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import {
  CHAINED_EXACT_PRIVILEGED_SCOPES,
  chainedCallerDomain as callerDomain,
  chainedFirstHopPrismaMock,
  chainedIssuer as issuer,
  chainedSourceDomain as sourceDomain,
  chainedUserId as userId,
  generateChainedKeys,
  generateSourceKeyMaterial,
  signFirstHopAssertion,
} from './confidential-chained-token-fixtures.js';

// The privileged first-hop/terminal-token contract, exercised through the
// production code paths only: the REAL first-hop exchange verifies Nessie's
// RS256 subject assertion against the exact published config JWKS, resolves
// the delegation through the REAL DB-mapping resolver (pinned server-owned
// nessie-identity row), consumes the jti, and signs with the production
// signer. The minted token is then verified directly for the exact
// auth-origin audience, and one onward privileged chained exchange must be
// refused by the real mapping policy before any signing happens. Privileged
// scopes are terminal: there is no legitimate downstream chain to fabricate.

const AUTH_ORIGIN_AUDIENCE = 'https://authentication.unlikeotherai.com';

let privateJwk: JWK;

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

beforeAll(async () => {
  const keys = await generateChainedKeys('uoa-chained-terminal-test');
  privateJwk = keys.privateJwk;
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

/** Prisma view behind the REAL resolver: the server-owned pinned
 *  nessie-identity mapping exactly as the admin surface would store it. */
function nessieIdentityDelegationPrisma(): PrismaClient {
  return {
    confidentialDelegationMapping: {
      findUnique: vi.fn().mockResolvedValue({
        clientDomainId: 'client-domain-nessie',
        product: 'nessie-identity',
        resource: AUTH_ORIGIN_AUDIENCE,
        scopes: [
          ConfidentialDelegationScope.IDENTITY_READ,
          ConfidentialDelegationScope.MEMBERSHIP_INVITE,
          ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
        ],
        enabled: true,
        clientDomain: { domain: sourceDomain, status: 'active' },
      }),
    },
  } as unknown as PrismaClient;
}

/** Caller-side mapping for a downstream product that claims a privileged
 *  scope: stored rows can drift, and the runtime policy must refuse them. */
function driftedPrivilegedCallerPrisma(): PrismaClient {
  return {
    confidentialDelegationMapping: {
      findUnique: vi.fn().mockResolvedValue({
        clientDomainId: 'client-domain-deepsignal',
        product: 'deepsignal',
        resource: AUTH_ORIGIN_AUDIENCE,
        scopes: [ConfidentialDelegationScope.IDENTITY_READ],
        enabled: true,
        clientDomain: { domain: callerDomain, status: 'active' },
      }),
    },
  } as unknown as PrismaClient;
}

describe('privileged nessie-identity first hop and terminal token', () => {
  it('mints a no-email auth-origin token through the real exchange, verifies it directly, and refuses onward privileged chaining', async () => {
    const { sourcePrivateKey, sourcePublicJwk, configJwt } = await generateSourceKeyMaterial();
    const subjectToken = await signFirstHopAssertion(sourcePrivateKey, sourcePublicJwk.kid!);
    const firstHopPrisma = chainedFirstHopPrismaMock();
    const delegationPrisma = nessieIdentityDelegationPrisma();

    const firstHop = await exchangeConfidentialSubjectToken(
      {
        authenticatedClientDomainId: 'client-domain-nessie',
        subjectToken,
        product: 'nessie-identity',
        resource: AUTH_ORIGIN_AUDIENCE,
        scope: CHAINED_EXACT_PRIVILEGED_SCOPES,
        config: {
          domain: sourceDomain,
          org_features: { enabled: true, groups_enabled: false },
        } as Parameters<typeof exchangeConfidentialSubjectToken>[0]['config'],
        configJwt,
      },
      {
        prisma: firstHopPrisma,
        fetchJwks: vi.fn().mockResolvedValue({ keys: [sourcePublicJwk] }),
        // The production resolver decides; the mapping row above is the exact
        // server pin, never a fabricated success path.
        resolveDelegation: (params) =>
          resolveConfidentialDelegation(params, { prisma: delegationPrisma }),
        consumeSubjectRateLimit: vi.fn(),
      },
    );

    // Minted by the production signer under the env JWKS: the privileged
    // profile carries no advisory email claim.
    const issued = decodeJwt(firstHop.accessToken);
    expect(issued).not.toHaveProperty('email');
    expect(issued).toMatchObject({
      iss: issuer,
      aud: AUTH_ORIGIN_AUDIENCE,
      sub: userId,
      product: 'nessie-identity',
      scope: CHAINED_EXACT_PRIVILEGED_SCOPES,
      azp: sourceDomain,
    });
    expect(firstHop.scope).toBe(CHAINED_EXACT_PRIVILEGED_SCOPES);
    expect(
      (
        firstHopPrisma as unknown as {
          confidentialAssertionUse: { create: ReturnType<typeof vi.fn> };
        }
      ).confidentialAssertionUse.create,
    ).toHaveBeenCalledOnce();

    // Directly verify the exact artifact for the exact auth-origin audience
    // through the real /oauth/jwks.json keyset — verification failures are
    // test failures, never logged and swallowed.
    const verified = await verifyChainedSubjectAccessToken({
      subjectToken: firstHop.accessToken,
      callerAudience: AUTH_ORIGIN_AUDIENCE,
      issuer,
    });
    expect(verified.sub).toBe(userId);
    expect(verified.aud).toBe(AUTH_ORIGIN_AUDIENCE);
    expect(verified.scope).toBe(CHAINED_EXACT_PRIVILEGED_SCOPES);
    expect(verified.email).toBeUndefined();

    // One onward chained exchange requesting a privileged scope: the real
    // privileged mapping policy rejects the caller's drifted mapping during
    // the preflight, before the token is even verified and long before
    // signing. The signer must never run for a privileged onward hop.
    const signBlocked = vi.fn();
    const callerPrisma = driftedPrivilegedCallerPrisma();
    await expect(
      exchangeConfidentialChainedAccessToken(
        {
          authenticatedClientDomainId: 'client-domain-deepsignal',
          subjectToken: firstHop.accessToken,
          product: 'deepsignal',
          resource: AUTH_ORIGIN_AUDIENCE,
          scope: 'identity.read',
          config: {
            domain: callerDomain,
            org_features: { enabled: true, groups_enabled: false },
          } as Parameters<typeof exchangeConfidentialChainedAccessToken>[0]['config'],
        },
        {
          prisma: chainedFirstHopPrismaMock(),
          signAccessToken: signBlocked,
          resolveDelegation: (params) =>
            resolveConfidentialDelegation(params, { prisma: callerPrisma }),
          resolveSourceDelegation: vi.fn(),
          consumeSubjectRateLimit: vi.fn(),
        },
      ),
    ).rejects.toThrow('TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED');
    expect(signBlocked).not.toHaveBeenCalled();
  });
});
