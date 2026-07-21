import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { updateAdminDomain } from '../../src/services/domain-secret.service.js';
import {
  exchangeAuthorizationCodeForTokens,
  exchangeRefreshTokenForTokens,
} from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'api.domain-race.example';
const configUrl = `https://${domain}/auth-config`;
const redirectUrl = `https://${domain}/oauth/callback`;
const verifier = 'client-domain-race-verifier-abcdefghijklmnopqrstuvwxyz';

type Seed = { clientDomainId: string; code: string; userId: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function config(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      redirect_urls: [redirectUrl],
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: false },
    }),
  );
}

describe.skipIf(!hasDatabase)('ClientDomain disable versus token issuance', () => {
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
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.clientDomain.deleteMany();
  });

  async function seed(): Promise<Seed> {
    const user = await handle.prisma.user.create({
      data: { email: `domain-race-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const clientDomain = await handle.prisma.clientDomain.create({
      data: { domain, label: 'Domain Race', status: 'active' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain,
        name: 'Domain Race Org',
        slug: `domain-race-${randomUUID()}`,
        ownerId: user.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Domain Race Team', slug: `team-${randomUUID()}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });
    const issued = await issueAuthorizationCode(
      {
        userId: user.id,
        domain,
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
    return { clientDomainId: clientDomain.id, code: issued.code, userId: user.id };
  }

  function exchange(seedRow: Seed, afterLock?: () => Promise<void>) {
    return exchangeAuthorizationCodeForTokens(
      {
        authenticatedClientDomainId: seedRow.clientDomainId,
        clientId: createClientId(domain, process.env.SHARED_SECRET!),
        code: seedRow.code,
        codeVerifier: verifier,
        config: config(),
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

  function refresh(seedRow: Seed, refreshToken: string) {
    return exchangeRefreshTokenForTokens(
      {
        authenticatedClientDomainId: seedRow.clientDomainId,
        clientId: createClientId(domain, process.env.SHARED_SECRET!),
        config: config(),
        configUrl,
        refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
    );
  }

  function disable(afterLock?: () => Promise<void>) {
    return updateAdminDomain(
      { domain, status: 'disabled', actorEmail: 'admin@example.com' },
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

  it('lets an exchange commit before a waiting domain disable', async () => {
    const seeded = await seed();
    const locked = deferred();
    const release = deferred();
    const tokenExchange = exchange(seeded, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const disabling = disable();
    await expectStillPending(disabling);
    release.resolve();

    await expect(tokenExchange).resolves.toMatchObject({ refreshToken: expect.any(String) });
    await expect(disabling).resolves.toMatchObject({ status: 'disabled' });
  });

  it('rejects exchange without consuming its code when domain disable wins', async () => {
    const seeded = await seed();
    const locked = deferred();
    const release = deferred();
    const disabling = disable(async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const tokenExchange = exchange(seeded);
    await expectStillPending(tokenExchange);
    release.resolve();

    await expect(disabling).resolves.toMatchObject({ status: 'disabled' });
    await expect(tokenExchange).rejects.toMatchObject({ statusCode: 401 });
    expect(await handle.prisma.refreshToken.count()).toBe(0);
    expect(
      await handle.prisma.authorizationCode.findFirstOrThrow({ select: { usedAt: true } }),
    ).toEqual({ usedAt: null });
  });

  it('rejects refresh without rotating when domain disable wins', async () => {
    const seeded = await seed();
    const initial = await exchange(seeded);
    const locked = deferred();
    const release = deferred();
    const disabling = disable(async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const rotation = refresh(seeded, initial.refreshToken);
    await expectStillPending(rotation);
    release.resolve();

    await expect(disabling).resolves.toMatchObject({ status: 'disabled' });
    await expect(rotation).rejects.toMatchObject({ statusCode: 401 });
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.userId } })).toBe(1);
    expect(
      await handle.prisma.refreshToken.findFirstOrThrow({
        where: { userId: seeded.userId },
        select: { lastUsedAt: true, replacedByTokenId: true },
      }),
    ).toEqual({ lastUsedAt: null, replacedByTokenId: null });
  });
});
