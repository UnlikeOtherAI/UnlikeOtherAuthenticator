import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runInTransaction } from '../../src/db/tenant-context.js';
import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { resolveProductWorkspaceBeforeTwoFa } from '../../src/services/required-workspace-placement.service.js';
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

  function authorize(params: {
    afterPlacementLock?: () => Promise<void>;
    domain: string;
    userId: string;
  }) {
    return runInTransaction(handle.prisma, async (tx) => {
      const config = productConfig(params.domain);
      const workspace = await resolveProductWorkspaceBeforeTwoFa(
        { userId: params.userId, config },
        {
          afterWorkspaceLock: params.afterPlacementLock,
          prisma: tx,
          workspacePrisma: tx,
        },
      );
      if (!workspace) throw new Error('recognized product did not resolve an exact workspace');

      const issued = await issueAuthorizationCode(
        {
          userId: params.userId,
          domain: params.domain,
          configUrl: `https://${params.domain}/auth-config`,
          redirectUrl: `https://${params.domain}/oauth/callback`,
          codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
          codeChallengeMethod: 'S256',
          rememberMe: true,
          twoFaCompleted: false,
          ...workspace,
        },
        {
          crossProductPrisma: tx,
          policyPrisma: tx,
          prisma: tx,
          sharedSecret: process.env.SHARED_SECRET!,
        },
      );
      return { code: issued.code, workspace };
    });
  }

  function exchange(params: { clientDomainId: string; code: string; domain: string }) {
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
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
    );
  }

  async function waitForPlacementLockWaiter(userId: string): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const [row] = await handle.prisma.$queryRaw<Array<{ count: number }>>`
        WITH placement_key AS (
          SELECT hashtextextended(
            ${`uoa:required-team-placement:${userId}`}, 0
          ) AS value
        )
        SELECT count(*)::int AS count
        FROM pg_locks, placement_key
        WHERE locktype = 'advisory'
          AND classid::bigint = ((value >> 32) & 4294967295)::bigint
          AND objid::bigint = (value & 4294967295)::bigint
          AND objsubid = 1
          AND NOT granted
      `;
      if ((row?.count ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the second product placement transaction');
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
    const placed = deferred();
    const release = deferred();
    const first = authorize({
      domain: firstDomain,
      userId: user.id,
      afterPlacementLock: async () => {
        placed.resolve();
        await release.promise;
      },
    });
    let second: ReturnType<typeof authorize> | undefined;
    try {
      await placed.promise;
      second = authorize({
        domain: secondDomain,
        userId: user.id,
      });
      await waitForPlacementLockWaiter(user.id);
      release.resolve();

      const [firstAuthorization, secondAuthorization] = await Promise.all([first, second]);
      expect(firstAuthorization.workspace).toEqual(secondAuthorization.workspace);

      const [firstTokens, secondTokens] = await Promise.all([
        exchange({
          clientDomainId: firstClientDomainId,
          code: firstAuthorization.code,
          domain: firstDomain,
        }),
        exchange({
          clientDomainId: secondClientDomainId,
          code: secondAuthorization.code,
          domain: secondDomain,
        }),
      ]);
      const firstActive = decodeJwt(firstTokens.accessToken).active;
      const secondActive = decodeJwt(secondTokens.accessToken).active;
      expect(firstActive).toEqual(secondActive);
      expect(firstActive).toMatchObject({ orgId: expect.any(String), teamId: expect.any(String) });
      expect(await handle.prisma.organisation.count()).toBe(1);
      expect(await handle.prisma.team.count()).toBe(1);
      expect(await handle.prisma.orgMember.count({ where: { userId: user.id } })).toBe(1);
      expect(await handle.prisma.teamMember.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled(second ? [first, second] : [first]);
    }
  });
});
