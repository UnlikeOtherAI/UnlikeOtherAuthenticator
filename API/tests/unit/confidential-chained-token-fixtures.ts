import type { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';

// Shared fixtures for the chained confidential token verification/exchange
// suites: one UOA signing keypair per file, the standard org/workspace
// claims, and the source-side JWKS/config-JWT pair a first-hop exchange
// verifies against.
export const chainedIssuer = 'https://authentication.unlikeotherai.com';
export const chainedSourceDomain = 'api.nessie.works';
export const chainedCallerDomain = 'api.deepsignal.live';
export const chainedCallerAudience = `https://${chainedCallerDomain}`;
export const chainedLedgerResource = 'https://ledger.unlikeotherai.com';
export const chainedUserId = 'usr_1';
export const chainedJwksUrl = `https://${chainedSourceDomain}/.well-known/jwks.json`;
export const CHAINED_EXACT_PRIVILEGED_SCOPES =
  'identity.read membership.invite membership.manage';

export type ChainedKeys = {
  privateKey: KeyLike;
  privateJwk: JWK;
  keyId: string;
};

export async function generateChainedKeys(keyId: string): Promise<ChainedKeys> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  Object.assign(privateJwk, { kid: keyId, alg: 'RS256', use: 'sig' });
  return { privateKey: pair.privateKey, privateJwk, keyId };
}

/** Generate a distinct source-side RS256 pair, the public JWKS it publishes,
 *  and a config JWT (signed by the same source key) pointing at that JWKS. */
export async function generateSourceKeyMaterial(): Promise<{
  sourcePrivateKey: KeyLike;
  sourcePublicJwk: JWK;
  configJwt: string;
}> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const sourcePublicJwk = await exportJWK(pair.publicKey);
  sourcePublicJwk.kid = 'nessie-subject-key';
  sourcePublicJwk.alg = 'RS256';
  sourcePublicJwk.use = 'sig';
  const configJwt = await new SignJWT({
    domain: chainedSourceDomain,
    jwks_url: chainedJwksUrl,
  })
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid })
    .sign(pair.privateKey);
  return { sourcePrivateKey: pair.privateKey, sourcePublicJwk, configJwt };
}

export function chainedConfig(): ClientConfig {
  return {
    domain: chainedCallerDomain,
    org_features: { enabled: true, groups_enabled: false },
  } as unknown as ClientConfig;
}

export function chainedDefaultOrg() {
  return {
    org_id: 'org_1',
    tenant_slug: 'nessie',
    org_role: 'member',
    teams: ['team_1', 'team_2'],
    team_roles: { team_1: 'member', team_2: 'admin' },
  };
}

/** Mock Prisma covering the chained exchange's re-resolution reads. */
export function chainedPrismaMock(options?: {
  domainRoleExists?: boolean;
  orgExists?: boolean;
  teams?: Array<{ teamId: string; teamRole: string }>;
  userExists?: boolean;
  tokenVersion?: number;
}): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({ domain: chainedCallerDomain, status: 'active' }),
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
        .mockResolvedValue(
          options?.orgExists === false
            ? null
            : { orgId: 'org_1', role: 'admin', org: { slug: 'nessie' } },
        ),
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

/** Mock Prisma for the first-hop confidential exchange: the source-side
 *  clientDomain lookup plus the assertion-consumption writes. */
export function chainedFirstHopPrismaMock(): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({ domain: chainedSourceDomain, status: 'active' }),
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

/** Sign a first-hop subject assertion with the source key, carrying the
 *  workspace selection the first-hop exchange re-resolves into `org` +
 *  `active`. */
export async function signFirstHopAssertion(
  sourcePrivateKey: KeyLike,
  kid: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    source_domain: chainedSourceDomain,
    tv: 0,
    active: { orgId: 'org_1', teamId: 'team_1' },
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(chainedSourceDomain)
    .setAudience(`${chainedIssuer}/auth/token`)
    .setSubject(chainedUserId)
    .setJti(`assertion_${crypto.randomUUID()}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(sourcePrivateKey);
}
