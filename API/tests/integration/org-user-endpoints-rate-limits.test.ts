import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import { clearOrgTestDatabase, createSignedConfigJwt, createTestUser, hasDatabase, OrgRecord, signAccessToken } from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('user-facing /org endpoints rate limits', () => {
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
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;

    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rate limits organisation creation at 5/hour per actor', async () => {
    const domain = 'org-rate-limit-create.example.com';
    const orgConfigUrl = 'https://org-rate-limit-create.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'rate-create-owner@example.com');
    const ownerToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);
    const app = await createApp();
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      const createRes = await app.inject({
        method: 'POST',
        url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
        },
        payload: { name: `Rate Org ${i}` },
      });
      expect(createRes.statusCode).toBe(200);
      const org = createRes.json() as OrgRecord;

      const orgOwnerToken = await signAccessToken({
        subject: owner.id,
        domain,
        secret: process.env.SHARED_SECRET!,
        issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
        org: {
          orgId: org.id,
          orgRole: 'owner',
          teams: [],
          team_roles: {},
        },
      });

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/org/organisations/${org.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${orgOwnerToken}`,
        },
      });
      expect(deleteRes.statusCode).toBe(200);
    }

    const blockedRes = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { name: 'Blocked Org' },
    });
    expect(blockedRes.statusCode).toBe(429);

    await app.close();
  });

  it('rate limits team creation at 50/hour per org', async () => {
    const domain = 'org-rate-limit-team.example.com';
    const orgConfigUrl = 'https://org-rate-limit-team.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'rate-team-owner@example.com');
    const ownerBaseToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);
    const createOrg = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerBaseToken}`,
      },
      payload: { name: 'Team Rate Limit Org' },
    });
    expect(createOrg.statusCode).toBe(200);
    const org = createOrg.json() as OrgRecord;

    const ownerToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: {
        orgId: org.id,
        orgRole: 'owner',
        teams: [],
        team_roles: {},
      },
    });

    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/org/organisations/${org.id}/teams?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
        },
        payload: { name: `Team ${i}` },
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { name: 'Blocked Team' },
    });
    expect(blocked.statusCode).toBe(429);

    await app.close();
  });

  it('rate limits org member addition at 100/hour per org', async () => {
    const domain = 'org-rate-limit-member.example.com';
    const orgConfigUrl = 'https://org-rate-limit-member.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'rate-member-owner@example.com');
    const ownerBaseToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);
    const createOrg = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerBaseToken}`,
      },
      payload: { name: 'Member Rate Limit Org' },
    });
    expect(createOrg.statusCode).toBe(200);
    const org = createOrg.json() as OrgRecord;

    const ownerToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: {
        orgId: org.id,
        orgRole: 'owner',
        teams: [],
        team_roles: {},
      },
    });

    for (let i = 0; i < 100; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
        },
        payload: { userId: `missing-member-${i}` },
      });
      expect(res.statusCode).toBe(400);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { userId: 'missing-member-final' },
    });
    expect(blocked.statusCode).toBe(429);

    await app.close();
  });
});

