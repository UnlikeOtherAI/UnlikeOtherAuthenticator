// The `/org/me` half of the user-facing org suite, split from
// org-user-endpoints-org.test.ts to keep both files under the project's
// 500-line limit. Same DB harness, same per-file isolated schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { getAdminAuthDomain } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { ORG_SUBJECT_ASSERTION_AUDIENCE } from '../../src/middleware/org-role-guard.js';
import { lockAndAssertAuthenticationEpochShared } from '../../src/services/authentication-epoch.service.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload, signTestConfigJwt } from '../helpers/test-config.js';
import { clearOrgTestDatabase, createSignedConfigJwt, createTestUser, hasDatabase, OrgMeRecord, OrgRecord, signAccessToken } from '../helpers/org-user-endpoints-helper.js';

const subjectJwks = vi.hoisted(() => ({ keys: [] as Record<string, unknown>[] }));
vi.mock('../../src/services/jwks-fetch.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/jwks-fetch.service.js')>();
  return { ...actual, fetchPartnerJwks: async () => ({ keys: subjectJwks.keys }) };
});

describe.skipIf(!hasDatabase)('user-facing /org/me org context', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAdminDatabaseUrl = process.env.DATABASE_ADMIN_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) {
      throw new Error('DATABASE_URL is required for DB-backed tests');
    }

    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.DATABASE_ADMIN_URL = originalAdminDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;

    if (handle) {
      await handle.cleanup();
    }
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;

    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });


  it('returns current org context from /org/me for org members', async () => {
    const domain = 'client.example.com';
    const orgConfigUrl = 'https://client.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, { allow_user_create_org: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'me-owner@example.com');
    const actorToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = await seedDomainSecret(handle!.prisma, domain);

    const createOrg = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${actorToken}`,
      },
      payload: { name: 'Acme Me Org' },
    });
    expect(createOrg.statusCode).toBe(200);
    const org = createOrg.json() as OrgRecord;

    const defaultTeam = await handle!.prisma.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    expect(defaultTeam).not.toBeNull();

    const meRes = await app.inject({
      method: 'GET',
      url: `/org/me?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${actorToken}`,
      },
    });

    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json() as { ok: true; org?: OrgMeRecord };
    expect(meBody.ok).toBe(true);
    expect(meRes.json().system_admin).toBe(false);
    expect(meBody.org).toMatchObject({
      org_id: org.id,
      org_role: 'owner',
      teams: [defaultTeam!.id],
    });
    // Founding an organisation makes you the steward of its first team, not a
    // rank-and-file member of it (organisation.service.organisation.ts) — the
    // creator's team role is `owner`, not Prisma's `member` column default.
    expect(meBody.org?.team_roles[defaultTeam!.id]).toBe('owner');
    // The directory is an ADDITIVE field. It must not be delivered as `teams`:
    // that key is the id array asserted above, and `team_roles` is keyed by it.
    expect(meBody.org?.team_directory).toEqual([
      expect.objectContaining({ teamId: defaultTeam!.id, orgId: org.id, name: 'Acme Me Org' }),
    ]);

    await app.close();
  });

  it('returns no org payload for users without org membership at /org/me', async () => {
    const domain = 'client.example.com';
    const orgConfigUrl = 'https://client.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(configJwt, { status: 200 })));

    const user = await createTestUser(handle!, 'me-anon@example.com');
    const userToken = await signAccessToken({
      subject: user.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = await seedDomainSecret(handle!.prisma, domain);
    const meRes = await app.inject({
      method: 'GET',
      url: `/org/me?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${userToken}`,
      },
    });

    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json() as { ok: true; org?: OrgMeRecord };
    expect(meBody).toEqual({ ok: true, system_admin: false });

    await app.close();
  });

  it('serves /org/me alongside other epoch readers while credential revocation waits', async () => {
    const domain = 'client.example.com';
    const configUrl = `https://${domain}/auth-config`;
    const jwksUrl = `https://${domain}/.well-known/jwks.json`;
    const configJwt = await signTestConfigJwt(baseClientConfigPayload({
      domain,
      redirect_urls: [`https://${domain}/oauth/callback`],
      jwks_url: jwksUrl,
      org_features: { enabled: true, allow_user_create_org: true },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'me-shared-reader@example.com');
    const domainHash = await seedDomainSecret(handle!.prisma, domain);
    const app = await createApp();
    await app.ready();
    const actorToken = await signAccessToken({ subject: owner.id, domain,
      secret: process.env.SHARED_SECRET!, issuer: process.env.AUTH_SERVICE_IDENTIFIER! });
    let org: OrgRecord;
    let teamId: string;
    try {
      const createOrg = await app.inject({
        method: 'POST',
        url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization: `Bearer ${domainHash}`, 'x-uoa-access-token': `Bearer ${actorToken}` },
        payload: { name: 'Shared reader org' },
      });
      expect(createOrg.statusCode).toBe(200);
      org = createOrg.json() as OrgRecord;
      const team = await handle!.prisma.team.findFirstOrThrow({
        where: { orgId: org.id, isDefault: true }, select: { id: true },
      });
      teamId = team.id;

      const pair = await generateKeyPair('RS256');
      const publicJwk = await exportJWK(pair.publicKey);
      subjectJwks.keys = [{ ...publicJwk, kid: 'org-me-reader', alg: 'RS256', use: 'sig' }];
      const issuedAt = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({ tv: 0, source_domain: domain,
        active: { orgId: org.id, teamId } })
        .setProtectedHeader({ alg: 'RS256', kid: 'org-me-reader', typ: 'JWT' })
        .setIssuer(domain).setAudience(ORG_SUBJECT_ASSERTION_AUDIENCE)
        .setSubject(owner.id).setJti('org-me-shared-reader')
        .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 60).sign(pair.privateKey);

      let readerEntered!: () => void;
      const entered = new Promise<void>((resolve) => { readerEntered = resolve; });
      let releaseReader!: () => void;
      const held = new Promise<void>((resolve) => { releaseReader = resolve; });
      const reader = handle!.prisma.$transaction(async (tx) => {
        await lockAndAssertAuthenticationEpochShared({ userId: owner.id,
          domain, credentialEpoch: 0 }, { prisma: tx, afterLock: async () => {
          readerEntered();
          await held;
        } });
      }, { isolationLevel: 'ReadCommitted', timeout: 10_000 });
      await entered;

      let revocation: Promise<void> | undefined;
      try {
        const me = await app.inject({ method: 'GET',
          url: `/org/me?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`,
          headers: { authorization: `Bearer ${domainHash}`,
            'x-uoa-subject-assertion': `Bearer ${assertion}` },
        });
        expect(me.statusCode).toBe(200);
        expect((me.json() as { org?: OrgMeRecord }).org?.org_id).toBe(org.id);

        let revokeEntered = false;
        revocation = revokeAllRefreshTokensForUser(owner.id, {
          prisma: handle!.prisma,
          afterUserLock: async () => { revokeEntered = true; },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(revokeEntered).toBe(false);
        releaseReader();
        await reader;
        await revocation;
        expect(revokeEntered).toBe(true);
      } finally {
        releaseReader();
        await reader.catch(() => undefined);
        await revocation?.catch(() => undefined);
      }
    } finally {
      await app.close();
    }
  });
  it('resolves platform authority live for token and signed assertion callers without trusting tenant roles', async () => {
    const domain = 'client.example.com';
    const configUrl = `https://${domain}/auth-config`;
    const configJwt = await signTestConfigJwt(baseClientConfigPayload({
      domain, redirect_urls: [`https://${domain}/oauth/callback`],
      jwks_url: `https://${domain}/.well-known/jwks.json`,
      org_features: { enabled: true, allow_user_create_org: true },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(configJwt, { status: 200 })));
    const user = await createTestUser(handle!, 'me-system-admin@example.com');
    const token = await signAccessToken({ subject: user.id, domain,
      secret: process.env.SHARED_SECRET!, issuer: process.env.AUTH_SERVICE_IDENTIFIER! });
    const domainHash = await seedDomainSecret(handle!.prisma, domain);
    const app = await createApp();
    await app.ready();
    const url = `/org/me?domain=${domain}&config_url=${encodeURIComponent(configUrl)}`;
    const read = (credential: Record<string, string> = { 'x-uoa-access-token': token }) =>
      app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${domainHash}`, ...credential } });
    const assertVerdict = async (credential: Record<string, string>, expected: boolean) => {
      const response = await read(credential);
      expect(response.statusCode).toBe(200);
      expect(response.json().system_admin).toBe(expected);
      expect(response.headers['cache-control']).toBe('private, no-store');
    };
    try {
      await assertVerdict({ 'x-uoa-access-token': token }, false);
      const created = await app.inject({ method: 'POST',
        url: `/org/organisations?domain=${domain}&config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization: `Bearer ${domainHash}`, 'x-uoa-access-token': token },
        payload: { name: 'System verdict org' } });
      expect(created.statusCode).toBe(200);
      const org = created.json() as OrgRecord;
      const team = await handle!.prisma.team.findFirstOrThrow({
        where: { orgId: org.id, isDefault: true }, select: { id: true } });
      await assertVerdict({ 'x-uoa-access-token': token }, false); // Org owner.
      await handle!.prisma.domainRole.upsert({
        where: { domain_userId: { domain, userId: user.id } },
        create: { domain, userId: user.id, role: 'SUPERUSER' }, update: { role: 'SUPERUSER' },
      });
      await assertVerdict({ 'x-uoa-access-token': token }, false); // Product bootstrap superuser.

      const pair = await generateKeyPair('RS256');
      subjectJwks.keys = [{ ...await exportJWK(pair.publicKey), kid: 'system-verdict', alg: 'RS256', use: 'sig' }];
      const mintAssertion = async (privateKey = pair.privateKey) => {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ tv: 0, source_domain: domain, active: { orgId: org.id, teamId: team.id } })
          .setProtectedHeader({ alg: 'RS256', kid: 'system-verdict', typ: 'JWT' })
          .setIssuer(domain).setAudience(ORG_SUBJECT_ASSERTION_AUDIENCE).setSubject(user.id)
          .setJti('system-verdict').setIssuedAt(now).setExpirationTime(now + 60).sign(privateKey);
      };
      const assertionCredential = { 'x-uoa-subject-assertion': await mintAssertion() };
      await assertVerdict(assertionCredential, false);
      const adminDomain = getAdminAuthDomain();
      await handle!.prisma.domainRole.create({ data: { domain: adminDomain, userId: user.id, role: 'SUPERUSER' } });
      await assertVerdict({ 'x-uoa-access-token': token }, true);
      await assertVerdict(assertionCredential, true);

      const forgedPair = await generateKeyPair('RS256');
      expect((await read({ 'x-uoa-subject-assertion': await mintAssertion(forgedPair.privateKey) })).statusCode).toBe(401);
      expect((await read({ ...assertionCredential, 'x-uoa-access-token': token })).statusCode).toBe(401);
      expect((await read({})).statusCode).toBe(401);
      await handle!.prisma.domainRole.delete({ where: { domain_userId: { domain: adminDomain, userId: user.id } } });
      await assertVerdict(assertionCredential, false); // Revocation cannot reuse a positive verdict.
      await handle!.prisma.domainRole.create({ data: { domain: adminDomain, userId: user.id, role: 'SUPERUSER' } });
      await handle!.prisma.teamMember.update({ where: { teamId_userId: { teamId: team.id, userId: user.id } }, data: { status: 'REMOVED' } });
      expect((await read(assertionCredential)).statusCode).toBe(403);
      await handle!.prisma.teamMember.update({ where: { teamId_userId: { teamId: team.id, userId: user.id } }, data: { status: 'ACTIVE' } });
      await handle!.prisma.user.update({ where: { id: user.id }, data: { lifecycleStatus: 'DISABLED' } });
      expect([401, 403]).toContain((await read(assertionCredential)).statusCode);
      await handle!.prisma.user.update({ where: { id: user.id }, data: { lifecycleStatus: 'ACTIVE', tokenVersion: { increment: 1 } } });
      expect((await read(assertionCredential)).statusCode).toBe(401);
      expect((await read({ 'x-uoa-access-token': token })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

});
