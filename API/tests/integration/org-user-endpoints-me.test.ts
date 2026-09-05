// The `/org/me` half of the user-facing org suite, split from
// org-user-endpoints-org.test.ts to keep both files under the project's
// 500-line limit. Same DB harness, same per-file isolated schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import { clearOrgTestDatabase, createSignedConfigJwt, createTestUser, hasDatabase, OrgMeRecord, OrgRecord, signAccessToken } from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('user-facing /org/me org context', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) {
      throw new Error('DATABASE_URL is required for DB-backed tests');
    }

    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
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
      expect.objectContaining({ teamId: defaultTeam!.id, orgId: org.id, name: 'General' }),
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
    expect(meBody).toEqual({ ok: true });

    await app.close();
  });
});
