import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { revokeBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import {
  exchangeAuthorizationCodeForTokens,
  exchangeRefreshTokenForTokens,
} from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const productDomain = 'api.policy-race.example';
const workspaceDomain = 'workspace.policy-race.example';
const configUrl = `https://${productDomain}/auth-config`;
const redirectUrl = `https://${productDomain}/oauth/callback`;
const verifier = 'product-policy-race-verifier-abcdefghijklmnopqrstuvwxyz';

type Seed = {
  appKeyId: string;
  clientDomainId: string;
  code: string;
  serviceId: string;
  userId: string;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function productConfig(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain: productDomain,
      redirect_urls: [redirectUrl],
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: false },
    }),
  );
}

describe.skipIf(!hasDatabase)('product workspace policy token races', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '15m';
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
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
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

  async function seed(): Promise<Seed> {
    const user = await handle.prisma.user.create({
      data: { email: `race-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const clientDomain = await handle.prisma.clientDomain.create({
      data: { domain: productDomain, label: 'Policy Race Product', status: 'active' },
      select: { id: true },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: 'policy-race', name: 'Policy Race' },
      select: { id: true },
    });
    const appKey = await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Policy race lifecycle',
        keyPrefix: `race_${randomUUID().slice(0, 8)}`,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        actorIssuer: `https://${productDomain}`,
        actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
        actorKeyId: 'policy-race-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${productDomain}`],
      },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain: workspaceDomain,
        name: 'Policy Race Workspace',
        slug: `policy-race-${randomUUID()}`,
        ownerId: user.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Policy Race Team', slug: `team-${randomUUID()}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });
    const issued = await issueAuthorizationCode(
      {
        userId: user.id,
        domain: productDomain,
        configUrl,
        redirectUrl,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        codeChallengeMethod: 'S256',
        rememberMe: true,
        orgId: org.id,
        teamId: team.id,
      },
      { prisma: handle.prisma, sharedSecret: process.env.SHARED_SECRET! },
    );
    return {
      appKeyId: appKey.id,
      clientDomainId: clientDomain.id,
      code: issued.code,
      serviceId: service.id,
      userId: user.id,
    };
  }

  function exchangeCode(seedRow: Seed, afterLock?: () => Promise<void>) {
    return exchangeAuthorizationCodeForTokens(
      {
        authenticatedClientDomainId: seedRow.clientDomainId,
        clientId: createClientId(productDomain, process.env.SHARED_SECRET!),
        code: seedRow.code,
        codeVerifier: verifier,
        config: productConfig(),
        configUrl,
        redirectUrl,
      },
      {
        adminPrisma: handle.prisma,
        afterProductWorkspacePolicyLock: afterLock,
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
    );
  }

  function refresh(seedRow: Seed, refreshToken: string, afterLock?: () => Promise<void>) {
    return exchangeRefreshTokenForTokens(
      {
        authenticatedClientDomainId: seedRow.clientDomainId,
        clientId: createClientId(productDomain, process.env.SHARED_SECRET!),
        config: productConfig(),
        configUrl,
        refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        afterProductWorkspacePolicyLock: afterLock,
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
    );
  }

  function revoke(seedRow: Seed, afterLock?: () => Promise<void>) {
    return revokeBillingAppKey(
      { serviceId: seedRow.serviceId, keyId: seedRow.appKeyId, actorEmail: 'admin@example.com' },
      { prisma: handle.prisma, afterProductPolicyLock: afterLock },
    );
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const state = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 40)),
    ]);
    expect(state).toBe('pending');
  }

  it('lets an authorization exchange commit before a waiting app-key revocation', async () => {
    const seeded = await seed();
    const locked = deferred();
    const release = deferred();
    const exchange = exchangeCode(seeded, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const revocation = revoke(seeded);
    await expectStillPending(revocation);
    release.resolve();

    await expect(exchange).resolves.toMatchObject({ refreshToken: expect.any(String) });
    await expect(revocation).resolves.toBeUndefined();
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.userId } })).toBe(1);
  });

  it('rolls back code consumption when app-key revocation wins', async () => {
    const seeded = await seed();
    const locked = deferred();
    const release = deferred();
    const revocation = revoke(seeded, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const exchange = exchangeCode(seeded);
    await expectStillPending(exchange);
    release.resolve();

    await expect(revocation).resolves.toBeUndefined();
    await expect(exchange).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
    expect(await handle.prisma.refreshToken.count()).toBe(0);
    expect(
      await handle.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: seeded.userId },
        select: { usedAt: true },
      }),
    ).toEqual({ usedAt: null });
  });

  it('lets refresh rotation commit before a waiting app-key revocation', async () => {
    const seeded = await seed();
    const initial = await exchangeCode(seeded);
    const locked = deferred();
    const release = deferred();
    const rotation = refresh(seeded, initial.refreshToken, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const revocation = revoke(seeded);
    await expectStillPending(revocation);
    release.resolve();

    const rotated = await rotation;
    await expect(revocation).resolves.toBeUndefined();
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.userId } })).toBe(2);
  });

  it('rolls back refresh rotation when app-key revocation wins', async () => {
    const seeded = await seed();
    const initial = await exchangeCode(seeded);
    const locked = deferred();
    const release = deferred();
    const revocation = revoke(seeded, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const rotation = refresh(seeded, initial.refreshToken);
    await expectStillPending(rotation);
    release.resolve();

    await expect(revocation).resolves.toBeUndefined();
    await expect(rotation).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.userId } })).toBe(1);
    expect(
      await handle.prisma.refreshToken.findFirstOrThrow({
        where: { userId: seeded.userId },
        select: { lastUsedAt: true, replacedByTokenId: true },
      }),
    ).toEqual({ lastUsedAt: null, replacedByTokenId: null });
  });
});
