import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { exchangeAuthorizationCodeForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const verifier = 'first-placement-race-verifier-abcdefghijklmnopqrstuvwxyz';
const productDomains = ['api.first-product.example', 'api.second-product.example'] as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function productConfig(domain: string): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      redirect_urls: [`https://${domain}/oauth/callback`],
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: true, user_needs_team: true },
    }),
  );
}

describe.skipIf(!hasDatabase)('first-placement per-user advisory lock', () => {
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

  async function createProduct(domain: string, index: number): Promise<string> {
    const clientDomain = await handle.prisma.clientDomain.create({
      data: { domain, label: `Placement Product ${index}`, status: 'active' },
      select: { id: true },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: `placement-product-${index}`, name: `Placement Product ${index}` },
      select: { id: true },
    });
    await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: `Placement lifecycle ${index}`,
        keyPrefix: `place_${index}_${randomUUID().slice(0, 6)}`,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        actorIssuer: `https://${domain}`,
        actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
        actorKeyId: `placement-key-${index}`,
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${domain}`],
      },
    });
    return clientDomain.id;
  }

  async function issueCode(userId: string, domain: string): Promise<string> {
    const issued = await issueAuthorizationCode(
      {
        userId,
        domain,
        configUrl: `https://${domain}/auth-config`,
        redirectUrl: `https://${domain}/oauth/callback`,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        codeChallengeMethod: 'S256',
        rememberMe: true,
        twoFaCompleted: false,
      },
      { prisma: handle.prisma, sharedSecret: process.env.SHARED_SECRET! },
    );
    return issued.code;
  }

  function exchange(params: {
    afterPlacementLock?: () => Promise<void>;
    clientDomainId: string;
    code: string;
    domain: string;
  }) {
    return exchangeAuthorizationCodeForTokens(
      {
        authenticatedClientDomainId: params.clientDomainId,
        clientId: createClientId(params.domain, process.env.SHARED_SECRET!),
        code: params.code,
        codeVerifier: verifier,
        config: productConfig(params.domain),
        configUrl: `https://${params.domain}/auth-config`,
        redirectUrl: `https://${params.domain}/oauth/callback`,
      },
      {
        adminPrisma: handle.prisma,
        afterRequiredWorkspaceLock: params.afterPlacementLock,
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
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

  it('creates one workspace when two products place the same new user simultaneously', async () => {
    const user = await handle.prisma.user.create({
      data: {
        email: 'first-placement@example.com',
        userKey: randomUUID(),
        name: 'First Placement',
      },
      select: { id: true },
    });
    const [firstDomain, secondDomain] = productDomains;
    const [firstClientDomainId, secondClientDomainId] = await Promise.all([
      createProduct(firstDomain, 1),
      createProduct(secondDomain, 2),
    ]);
    const [firstCode, secondCode] = await Promise.all([
      issueCode(user.id, firstDomain),
      issueCode(user.id, secondDomain),
    ]);
    const placed = deferred();
    const release = deferred();
    const first = exchange({
      clientDomainId: firstClientDomainId,
      code: firstCode,
      domain: firstDomain,
      afterPlacementLock: async () => {
        placed.resolve();
        await release.promise;
      },
    });
    await placed.promise;

    const second = exchange({
      clientDomainId: secondClientDomainId,
      code: secondCode,
      domain: secondDomain,
    });
    await expectStillPending(second);
    release.resolve();

    const [firstTokens, secondTokens] = await Promise.all([first, second]);
    const firstActive = decodeJwt(firstTokens.accessToken).active;
    const secondActive = decodeJwt(secondTokens.accessToken).active;
    expect(firstActive).toEqual(secondActive);
    expect(firstActive).toMatchObject({ orgId: expect.any(String), teamId: expect.any(String) });
    expect(await handle.prisma.organisation.count()).toBe(1);
    expect(await handle.prisma.team.count()).toBe(1);
    expect(await handle.prisma.orgMember.count({ where: { userId: user.id } })).toBe(1);
    expect(await handle.prisma.teamMember.count({ where: { userId: user.id } })).toBe(1);
  });
});
