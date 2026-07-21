import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const { configJwts } = vi.hoisted(() => ({ configJwts: new Map<string, string>() }));
vi.mock('../../src/services/config-jwt-source.service.js', () => ({
  readConfigJwtFromTrustedSource: vi.fn(async (configUrl: string) => {
    const jwt = configJwts.get(configUrl);
    if (!jwt) throw new Error(`missing test config for ${configUrl}`);
    return jwt;
  }),
}));

const hasDatabase = Boolean(process.env.DATABASE_URL);
const pkceChallenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!hasDatabase)('email-route first-product placement transaction', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    await handle.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${handle.schema}".email_route_code_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.domain LIKE 'rollback-%' THEN
          RAISE EXCEPTION 'forced authorization-code failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await handle.prisma.$executeRawUnsafe(`
      CREATE TRIGGER email_route_code_failure
      BEFORE INSERT ON "${handle.schema}".authorization_codes
      FOR EACH ROW EXECUTE FUNCTION "${handle.schema}".email_route_code_failure()
    `);
  });

  afterEach(() => {
    configJwts.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  async function createProduct(
    domain: string,
  ): Promise<{ configUrl: string; redirectUrl: string }> {
    const identifier = `email-route-${randomUUID()}`;
    await handle.prisma.clientDomain.create({
      data: { domain, label: domain, status: 'active', twoFaPolicy: 'OFF' },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier, name: domain },
      select: { id: true },
    });
    await handle.prisma.billingAppKey.create({
      data: {
        actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
        actorIssuer: `https://${domain}`,
        actorKeyId: `email-route-${randomUUID()}`,
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${domain}`],
        keyPrefix: `email_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        name: domain,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        serviceId: service.id,
      },
    });
    return {
      configUrl: `https://${domain}/auth-config`,
      redirectUrl: `https://${domain}/oauth/callback`,
    };
  }

  async function signedConfig(domain: string, redirectUrl: string): Promise<string> {
    return signTestConfigJwt(
      baseClientConfigPayload({
        domain,
        redirect_urls: [redirectUrl],
        registration_mode: 'passwordless',
        user_scope: 'global',
        '2fa_enabled': false,
        login_flow: { email_code_enabled: false, workspace_selection: 'off' },
        org_features: { enabled: true, user_needs_team: true },
      }),
    );
  }

  async function createToken(params: {
    configUrl: string;
    email: string;
    rawToken: string;
    type: 'LOGIN_LINK' | 'VERIFY_EMAIL';
    userId: string;
  }): Promise<string> {
    const tokenHash = hashEmailToken(params.rawToken, process.env.SHARED_SECRET!);
    await handle.prisma.verificationToken.create({
      data: {
        configUrl: params.configUrl,
        domain: null,
        email: params.email,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        tokenHash,
        type: params.type,
        userId: params.userId,
        userKey: params.email,
      },
    });
    return tokenHash;
  }

  function query(configUrl: string, redirectUrl: string): string {
    return (
      `config_url=${encodeURIComponent(configUrl)}` +
      `&redirect_url=${encodeURIComponent(redirectUrl)}` +
      `&code_challenge=${pkceChallenge}&code_challenge_method=S256`
    );
  }

  type LockState = { placementWaiters: number; relationWaiters: number };

  async function readLockState(userId: string): Promise<LockState> {
    const [row] = await handle.prisma.$queryRawUnsafe<LockState[]>(`
      WITH placement_key AS (
        SELECT hashtextextended(
          'uoa:required-team-placement:${userId}', 0
        ) AS value
      )
      SELECT
        (
          SELECT count(*)::int
          FROM pg_locks
          WHERE locktype = 'relation'
            AND relation = '"${handle.schema}".team_members'::regclass
            AND NOT granted
        ) AS "relationWaiters",
        (
          SELECT count(*)::int
          FROM pg_locks, placement_key
          WHERE locktype = 'advisory'
            AND classid::bigint = ((value >> 32) & 4294967295)::bigint
            AND objid::bigint = (value & 4294967295)::bigint
            AND objsubid = 1
            AND NOT granted
        ) AS "placementWaiters"
    `);
    return row ?? { placementWaiters: 0, relationWaiters: 0 };
  }

  async function waitForLockState(
    userId: string,
    predicate: (state: LockState) => boolean,
  ): Promise<LockState> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const state = await readLockState(userId);
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the email placement race window');
  }

  it('serializes concurrent GET and POST first placement across two products', async () => {
    const user = await handle.prisma.user.create({
      data: {
        email: 'email-route-race@example.com',
        name: 'Email Route Race',
        userKey: 'email-route-race@example.com',
      },
      select: { id: true },
    });
    const firstDomain = 'email-get-product.example';
    const secondDomain = 'email-post-product.example';
    const [first, second] = await Promise.all([
      createProduct(firstDomain),
      createProduct(secondDomain),
    ]);
    const firstRawToken = 'email-get-race-token';
    const secondRawToken = 'email-post-race-token';
    await Promise.all([
      createToken({
        configUrl: first.configUrl,
        email: 'email-route-race@example.com',
        rawToken: firstRawToken,
        type: 'LOGIN_LINK',
        userId: user.id,
      }),
      createToken({
        configUrl: second.configUrl,
        email: 'email-route-race@example.com',
        rawToken: secondRawToken,
        type: 'VERIFY_EMAIL',
        userId: user.id,
      }),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        await createTestConfigFetchHandler({
          [first.configUrl]: await signedConfig(firstDomain, first.redirectUrl),
          [second.configUrl]: await signedConfig(secondDomain, second.redirectUrl),
        }),
      ),
    );
    configJwts.set(first.configUrl, await signedConfig(firstDomain, first.redirectUrl));
    configJwts.set(second.configUrl, await signedConfig(secondDomain, second.redirectUrl));

    const tableLockHeld = deferred();
    const releaseTableLock = deferred();
    const tableBlocker = handle.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE "${handle.schema}".team_members IN ACCESS EXCLUSIVE MODE`,
        );
        tableLockHeld.resolve();
        await releaseTableLock.promise;
      },
      { timeout: 10_000 },
    );
    await tableLockHeld.promise;

    const app = await createApp();
    await app.ready();
    let placementBlocker: Promise<void> | undefined;
    let releasePlacementLock: ReturnType<typeof deferred> | undefined;
    try {
      const firstRequest = app.inject({
        method: 'GET',
        url:
          `/auth/email/link?${query(first.configUrl, first.redirectUrl)}` +
          `&token=${encodeURIComponent(firstRawToken)}`,
      });
      await waitForLockState(user.id, (state) => state.relationWaiters >= 1);

      const secondRequest = app.inject({
        method: 'POST',
        url: `/auth/verify-email?${query(second.configUrl, second.redirectUrl)}`,
        payload: { token: secondRawToken },
      });
      const concurrentState = await waitForLockState(
        user.id,
        (state) => state.relationWaiters >= 2 || state.placementWaiters >= 1,
      );

      // On the vulnerable implementation both requests release the one-statement advisory lock
      // and reach the zero-choice query. Pin them after that read so the same-domain recheck in
      // ensureUserHasRequiredTeam deterministically creates two product-local workspaces. With the
      // fixed route transaction, only one query reaches the table and the other request is already
      // waiting on the placement lock, so this branch is unreachable.
      if (concurrentState.relationWaiters >= 2) {
        const placementLockHeld = deferred();
        releasePlacementLock = deferred();
        placementBlocker = handle.prisma.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe(
              `SELECT pg_advisory_xact_lock(hashtextextended(` +
                `'uoa:required-team-placement:${user.id}', 0))::text AS lock_result`,
            );
            placementLockHeld.resolve();
            await releasePlacementLock!.promise;
          },
          { timeout: 10_000 },
        );
        await placementLockHeld.promise;
      }

      releaseTableLock.resolve();
      await tableBlocker;
      if (releasePlacementLock) {
        await waitForLockState(user.id, (state) => state.placementWaiters >= 2);
        releasePlacementLock.resolve();
        await placementBlocker;
      }

      const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
      expect(firstResponse.statusCode, firstResponse.body).toBe(302);
      expect(secondResponse.statusCode, secondResponse.body).toBe(200);
      expect(
        new URL(firstResponse.headers.location as string).searchParams.get('code'),
      ).toBeTruthy();
      expect((secondResponse.json() as { code?: string }).code).toBeTruthy();

      const codes = await handle.prisma.authorizationCode.findMany({
        where: { userId: user.id, domain: { in: [firstDomain, secondDomain] } },
        select: { domain: true, orgId: true, teamId: true },
      });
      expect(codes).toHaveLength(2);
      expect(codes[0]).toMatchObject({ orgId: expect.any(String), teamId: expect.any(String) });
      expect(new Set(codes.map((row) => `${row.orgId}:${row.teamId}`)).size).toBe(1);
      expect(await handle.prisma.organisation.count({ where: { ownerId: user.id } })).toBe(1);
      expect(await handle.prisma.orgMember.count({ where: { userId: user.id } })).toBe(1);
      expect(await handle.prisma.teamMember.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      releaseTableLock.resolve();
      releasePlacementLock?.resolve();
      await tableBlocker.catch(() => undefined);
      await placementBlocker?.catch(() => undefined);
      await app.close();
    }
  });

  async function expectCodeFailureRollsBack(route: 'get' | 'post'): Promise<void> {
    const domain = `rollback-${route}.example`;
    const product = await createProduct(domain);
    const email = `rollback-${route}@example.com`;
    const user = await handle.prisma.user.create({
      data: { email, userKey: email },
      select: { id: true },
    });
    const rawToken = `rollback-${route}-token`;
    const tokenHash = await createToken({
      configUrl: product.configUrl,
      email,
      rawToken,
      type: route === 'get' ? 'LOGIN_LINK' : 'VERIFY_EMAIL',
      userId: user.id,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        await createTestConfigFetchHandler({
          [product.configUrl]: await signedConfig(domain, product.redirectUrl),
        }),
      ),
    );
    configJwts.set(product.configUrl, await signedConfig(domain, product.redirectUrl));

    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject(
        route === 'get'
          ? {
              method: 'GET',
              url:
                `/auth/email/link?${query(product.configUrl, product.redirectUrl)}` +
                `&token=${encodeURIComponent(rawToken)}`,
            }
          : {
              method: 'POST',
              url: `/auth/verify-email?${query(product.configUrl, product.redirectUrl)}`,
              payload: { token: rawToken },
            },
      );
      expect(response.statusCode, response.body).toBe(500);
      expect(await handle.prisma.organisation.count({ where: { domain } })).toBe(0);
      expect(await handle.prisma.orgMember.count({ where: { userId: user.id } })).toBe(0);
      expect(await handle.prisma.teamMember.count({ where: { userId: user.id } })).toBe(0);
      expect(await handle.prisma.authorizationCode.count({ where: { domain } })).toBe(0);
      const consumed = await handle.prisma.verificationToken.findUniqueOrThrow({
        where: { tokenHash },
        select: { usedAt: true },
      });
      expect(consumed.usedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  }

  it('rolls GET placement back when authorization-code issuance fails', async () => {
    await expectCodeFailureRollsBack('get');
  });

  it('rolls POST placement back when authorization-code issuance fails', async () => {
    await expectCodeFailureRollsBack('post');
  });
});
