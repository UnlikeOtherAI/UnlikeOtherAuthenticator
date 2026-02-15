import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import { clearOrgTestDatabase, createSignedConfigJwt, createTestUser, hasDatabase, OrgListRecord, OrgMemberRecord, OrgRecord, signAccessToken } from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('user-facing /org organisations and members', () => {
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

  it('performs org CRUD and list pagination', async () => {
    const domain = 'org-crud.example.com';
    const orgConfigUrl = 'https://org-crud.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const ownerA = await createTestUser(handle!, 'owner-a@example.com');
    const ownerB = await createTestUser(handle!, 'owner-b@example.com');
    const ownerC = await createTestUser(handle!, 'owner-c@example.com');

    const tokenA = await signAccessToken({
      subject: ownerA.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });
    const tokenB = await signAccessToken({
      subject: ownerB.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });
    const tokenC = await signAccessToken({
      subject: ownerC.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);
    const orgPayloads = [
      { token: tokenA, ownerName: 'Acme Apollo' },
      { token: tokenB, ownerName: 'Acme Borealis' },
      { token: tokenC, ownerName: 'Acme Cygnus' },
    ];

    const createdOrgIds: string[] = [];
    for (const payload of orgPayloads) {
      const createRes = await app.inject({
        method: 'POST',
        url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${payload.token}`,
        },
        payload: { name: payload.ownerName },
      });

      expect(createRes.statusCode).toBe(200);
      const created = createRes.json() as OrgRecord;
      createdOrgIds.push(created.id);
      expect(created.name).toBe(payload.ownerName);
      expect(created.slug).toContain('acme');
    }

    const queryFirst = await app.inject({
      method: 'GET',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=2`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${tokenA}`,
      },
    });
    expect(queryFirst.statusCode).toBe(200);
    const firstPage = queryFirst.json() as { data: OrgListRecord[]; next_cursor: string | null };
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.next_cursor).not.toBeNull();

    const querySecond = await app.inject({
      method: 'GET',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=2&cursor=${encodeURIComponent(
        firstPage.next_cursor!,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${tokenA}`,
      },
    });
    expect(querySecond.statusCode).toBe(200);
    const secondPage = querySecond.json() as { data: OrgListRecord[]; next_cursor: string | null };
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.next_cursor).toBeNull();

    const allOrgIds = [...firstPage.data, ...secondPage.data].map((row) => row.id);
    expect(new Set(allOrgIds).size).toBe(3);

    const ownerTokenForUpdate = await signAccessToken({
      subject: ownerA.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: {
        orgId: createdOrgIds[0],
        orgRole: 'owner',
        teams: [],
        team_roles: {},
      },
    });

    const readRes = await app.inject({
      method: 'GET',
      url: `/org/organisations/${createdOrgIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerTokenForUpdate}`,
      },
    });
    expect(readRes.statusCode).toBe(200);
    const readOrg = readRes.json() as OrgListRecord;
    expect(readOrg.id).toBe(createdOrgIds[0]);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/org/organisations/${createdOrgIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerTokenForUpdate}`,
      },
      payload: { name: 'Acme Apollo One' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect((updateRes.json() as OrgRecord).name).toBe('Acme Apollo One');

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/org/organisations/${createdOrgIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerTokenForUpdate}`,
      },
    });
    expect(deleteRes.statusCode).toBe(200);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/org/organisations/${createdOrgIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerTokenForUpdate}`,
      },
    });
    expect(afterDelete.statusCode).toBe(404);

    await app.close();
  });

  it('manages org members with pagination and role changes', async () => {
    const domain = 'org-members.example.com';
    const orgConfigUrl = 'https://org-members.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'member-owner@example.com');
    const addMemberOne = await createTestUser(handle!, 'member-one@example.com');
    const addMemberTwo = await createTestUser(handle!, 'member-two@example.com');

    const actorToken = await signAccessToken({
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
        'x-uoa-access-token': `Bearer ${actorToken}`,
      },
      payload: { name: 'Acme Members' },
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

    const addOne = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { userId: addMemberOne.id, role: 'admin' },
    });
    expect(addOne.statusCode).toBe(200);
    expect((addOne.json() as OrgMemberRecord).role).toBe('admin');

    const addTwo = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { userId: addMemberTwo.id },
    });
    expect(addTwo.statusCode).toBe(200);
    expect((addTwo.json() as OrgMemberRecord).role).toBe('member');

    const memberListFirst = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=2`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(memberListFirst.statusCode).toBe(200);
    const memberPageOne = memberListFirst.json() as { data: OrgMemberRecord[]; next_cursor: string | null };
    expect(memberPageOne.data).toHaveLength(2);
    expect(memberPageOne.next_cursor).not.toBeNull();

    const memberListSecond = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=2&cursor=${encodeURIComponent(
        memberPageOne.next_cursor!,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(memberListSecond.statusCode).toBe(200);
    const memberPageTwo = memberListSecond.json() as { data: OrgMemberRecord[]; next_cursor: string | null };
    expect(memberPageTwo.data).toHaveLength(1);
    expect(memberPageTwo.next_cursor).toBeNull();

    const allMemberIds = [...memberPageOne.data, ...memberPageTwo.data].map((row) => row.userId);
    expect(allMemberIds).toContain(addMemberOne.id);
    expect(allMemberIds).toContain(addMemberTwo.id);
    expect(allMemberIds).toContain(owner.id);

    const roleChange = await app.inject({
      method: 'PUT',
      url: `/org/organisations/${org.id}/members/${addMemberTwo.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { role: 'admin' },
    });
    expect(roleChange.statusCode).toBe(200);
    expect((roleChange.json() as OrgMemberRecord).role).toBe('admin');

    const removeMember = await app.inject({
      method: 'DELETE',
      url: `/org/organisations/${org.id}/members/${addMemberTwo.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(removeMember.statusCode).toBe(200);

    const afterRemoval = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=10`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(afterRemoval.statusCode).toBe(200);
    const remaining = afterRemoval.json() as { data: OrgMemberRecord[]; next_cursor: string | null };
    const remainingIds = remaining.data.map((row) => row.userId);
    expect(remainingIds).not.toContain(addMemberTwo.id);
    expect(remainingIds).toContain(addMemberOne.id);
    expect(remainingIds).toContain(owner.id);

    await app.close();
  });
});
