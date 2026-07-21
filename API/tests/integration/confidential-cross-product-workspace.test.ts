import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { revokeBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { exchangeConfidentialChainedAccessToken } from '../../src/services/confidential-chained-token-exchange.service.js';
import { exchangeConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import type { ConfidentialAccessTokenClaims } from '../../src/services/oauth/access-token.service.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const issuer = 'https://authentication.unlikeotherai.com';
const workspaceDomain = 'canonical-workspace.example';
const ledgerResource = 'https://ledger.unlikeotherai.com';

type Seed = {
  appKeyId: string;
  clientDomainId: string;
  orgId: string;
  serviceId: string;
  teamId: string;
  userId: string;
};

let privateKey: KeyLike;
let publicJwk: JWK;

function config(domain: string, orgFeaturesEnabled: boolean): ClientConfig {
  return {
    domain,
    org_features: { enabled: orgFeaturesEnabled, groups_enabled: false },
  } as ClientConfig;
}

describe.skipIf(!hasDatabase)('confidential cross-product workspace attribution', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    Object.assign(publicJwk, { kid: 'cross-product-test-key', alg: 'RS256', use: 'sig' });

    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.PUBLIC_BASE_URL = issuer;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle.prisma.adminAuditLog.deleteMany();
    await handle.prisma.confidentialAssertionUse.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.billingAppKey.deleteMany();
    await handle.prisma.billingService.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.clientDomain.deleteMany();
  });

  async function seed(sourceDomain: string, callerDomain?: string): Promise<Seed> {
    const user = await handle.prisma.user.create({
      data: { email: `cross-product-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const sourceClient = await handle.prisma.clientDomain.create({
      data: { domain: sourceDomain, label: 'Source Product', status: 'active' },
      select: { id: true },
    });
    if (callerDomain && callerDomain !== sourceDomain) {
      await handle.prisma.clientDomain.create({
        data: { domain: callerDomain, label: 'Caller Product', status: 'active' },
      });
    }
    const service = await handle.prisma.billingService.create({
      data: { identifier: `source-${randomUUID()}`, name: 'Source Product' },
      select: { id: true },
    });
    const appKey = await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Source lifecycle',
        keyPrefix: `source_${randomUUID().slice(0, 8)}`,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        actorIssuer: `https://${sourceDomain}`,
        actorAudience: `${issuer}/billing/v1/effective-tariff`,
        actorKeyId: 'source-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${sourceDomain}`],
      },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain: workspaceDomain,
        name: 'Canonical Workspace',
        slug: `canonical-${randomUUID()}`,
        ownerId: user.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Canonical Team', slug: `canonical-${randomUUID()}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });
    await handle.prisma.domainRole.create({
      data: { domain: sourceDomain, userId: user.id, role: 'USER' },
    });
    return {
      appKeyId: appKey.id,
      clientDomainId: sourceClient.id,
      orgId: org.id,
      serviceId: service.id,
      teamId: team.id,
      userId: user.id,
    };
  }

  async function revoke(seedRow: Seed): Promise<void> {
    await revokeBillingAppKey(
      { serviceId: seedRow.serviceId, keyId: seedRow.appKeyId, actorEmail: 'admin@example.com' },
      { prisma: handle.prisma },
    );
  }

  async function signSubject(params: {
    domain: string;
    jti: string;
    seed: Seed;
    withActive: boolean;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      source_domain: params.domain,
      ...(params.withActive
        ? { active: { orgId: params.seed.orgId, teamId: params.seed.teamId } }
        : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid!, typ: 'JWT' })
      .setIssuer(params.domain)
      .setAudience(`${issuer}/auth/token`)
      .setSubject(params.seed.userId)
      .setJti(params.jti)
      .setIssuedAt(now)
      .setExpirationTime(now + 60);
    return jwt.sign(privateKey);
  }

  it('keeps subject-token attribution cross-domain and rejects omission or policy revocation', async () => {
    const sourceDomain = 'api.subject-product.example';
    const seeded = await seed(sourceDomain);
    const configJwt = await new SignJWT({
      domain: sourceDomain,
      jwks_url: `https://${sourceDomain}/.well-known/jwks.json`,
    })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
      .sign(privateKey);
    const signAccessToken = vi.fn().mockResolvedValue('delegated-access-token');
    const resolveDelegation = vi.fn().mockResolvedValue({
      product: 'subject-product',
      resource: ledgerResource,
      scope: 'ai.invoke',
    });
    const exchange = (subjectToken: string) =>
      exchangeConfidentialSubjectToken(
        {
          authenticatedClientDomainId: seeded.clientDomainId,
          subjectToken,
          product: 'subject-product',
          resource: ledgerResource,
          scope: 'ai.invoke',
          config: config(sourceDomain, false),
          configJwt,
        },
        {
          prisma: handle.prisma,
          fetchJwks: async () => ({ keys: [publicJwk] }),
          resolveDelegation,
          consumeAssertion: async () => {},
          consumeSubjectRateLimit: () => {},
          signAccessToken,
        },
      );

    await expect(
      exchange(
        await signSubject({ domain: sourceDomain, jti: 'active', seed: seeded, withActive: true }),
      ),
    ).resolves.toMatchObject({ accessToken: 'delegated-access-token' });
    expect(signAccessToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: { orgId: seeded.orgId, teamId: seeded.teamId },
        org: expect.objectContaining({ org_id: seeded.orgId, teams: [seeded.teamId] }),
      }),
    );

    await expect(
      exchange(
        await signSubject({
          domain: sourceDomain,
          jti: 'missing',
          seed: seeded,
          withActive: false,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' });
    await revoke(seeded);
    await expect(
      exchange(
        await signSubject({ domain: sourceDomain, jti: 'revoked', seed: seeded, withActive: true }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' });
  });

  it('keeps chained attribution cross-domain and rejects original-product policy revocation', async () => {
    const sourceDomain = 'api.original-product.example';
    const callerDomain = 'api.caller-product.example';
    const seeded = await seed(sourceDomain, callerDomain);
    const callerClient = await handle.prisma.clientDomain.findUniqueOrThrow({
      where: { domain: callerDomain },
      select: { id: true },
    });
    const now = Math.floor(Date.now() / 1000);
    const subjectToken = await new SignJWT({
      email: 'cross-product@example.com',
      source_domain: sourceDomain,
      azp: sourceDomain,
      product: 'original-product',
      scope: 'ai.invoke',
      active: { orgId: seeded.orgId, teamId: seeded.teamId },
      org: {
        org_id: seeded.orgId,
        org_role: 'owner',
        teams: [seeded.teamId],
        team_roles: { [seeded.teamId]: 'owner' },
      },
    })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid!, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(`https://${callerDomain}`)
      .setSubject(seeded.userId)
      .setJti('chained-cross-product')
      .setIssuedAt(now)
      .setExpirationTime(now + 240)
      .sign(privateKey);
    const signAccessToken = vi.fn().mockResolvedValue('chained-access-token');
    const exchange = () =>
      exchangeConfidentialChainedAccessToken(
        {
          authenticatedClientDomainId: callerClient.id,
          subjectToken,
          product: 'caller-product',
          resource: ledgerResource,
          scope: 'ai.invoke',
          config: config(callerDomain, true),
        },
        {
          prisma: handle.prisma,
          now: () => now,
          getAccessTokenJwks: async () => ({ keys: [publicJwk] }),
          resolveDelegation: vi.fn().mockResolvedValue({
            product: 'caller-product',
            resource: ledgerResource,
            scope: 'ai.invoke',
          }),
          resolveSourceDelegation: vi.fn().mockResolvedValue({
            product: 'original-product',
            resource: `https://${callerDomain}`,
            scope: 'ai.invoke',
          }),
          consumeSubjectRateLimit: () => {},
          signAccessToken,
        },
      );

    await expect(exchange()).resolves.toMatchObject({ accessToken: 'chained-access-token' });
    const claims = signAccessToken.mock.calls[0]?.[0] as ConfidentialAccessTokenClaims;
    expect(claims.active).toEqual({ orgId: seeded.orgId, teamId: seeded.teamId });
    expect(claims.org).toMatchObject({ org_id: seeded.orgId, teams: [seeded.teamId] });

    await revoke(seeded);
    await expect(exchange()).rejects.toMatchObject({
      statusCode: 403,
      message: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN',
    });
  });
});
