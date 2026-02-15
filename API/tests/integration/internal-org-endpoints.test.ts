import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
} from '../helpers/org-user-endpoints-helper.js';

const testDomain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';

async function stubValidInternalConfig(sharedSecret: string, groupsEnabled: boolean): Promise<void> {
  const configJwt = await createSignedConfigJwt(sharedSecret, {
    groups_enabled: groupsEnabled,
  });

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));
}

describe.skipIf(!hasDatabase)('internal /internal/org endpoints', () => {
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

  it('supports create/update/delete for internal groups', async () => {
    await stubValidInternalConfig(process.env.SHARED_SECRET!, true);

    const owner = await createTestUser(handle!, 'owner@example.com');
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: testDomain,
        name: 'Acme Internal Org',
        slug: 'acme-internal-org',
        ownerId: owner.id,
      },
      select: { id: true },
    });

    const domainHash = createClientId(testDomain, process.env.SHARED_SECRET!);
    const app = await createApp();
    await app.ready();

    const createResponse = await app.inject({
      method: 'POST',
      url: `/internal/org/organisations/${org.id}/groups?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        name: 'Support',
        description: 'Internal support group',
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json() as { id: string; orgId: string; name: string; description: string | null };
    expect(created.orgId).toBe(org.id);
    expect(created.name).toBe('Support');
    expect(created.description).toBe('Internal support group');

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/internal/org/organisations/${org.id}/groups/${created.id}?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        name: 'Customer Support',
        description: 'Customer support queue',
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { id: string; name: string; description: string | null };
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Customer Support');
    expect(updated.description).toBe('Customer support queue');

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/internal/org/organisations/${org.id}/groups/${created.id}?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ ok: true });

    const remaining = await handle!.prisma.group.findMany({ where: { orgId: org.id } });
    expect(remaining).toHaveLength(0);

    await app.close();
  });

  it('manages internal group membership add/update/remove', async () => {
    await stubValidInternalConfig(process.env.SHARED_SECRET!, true);

    const owner = await createTestUser(handle!, 'owner@example.com');
    const member = await createTestUser(handle!, 'member@example.com');
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: testDomain,
        name: 'Acme Internal Org',
        slug: 'acme-internal-org-members',
        ownerId: owner.id,
      },
      select: { id: true },
    });
    await handle!.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: member.id, role: 'member' },
      ],
    });
    const group = await handle!.prisma.group.create({
      data: {
        orgId: org.id,
        name: 'Ops',
        description: 'Operations',
      },
      select: { id: true },
    });

    const domainHash = createClientId(testDomain, process.env.SHARED_SECRET!);
    const app = await createApp();
    await app.ready();

    const addResponse = await app.inject({
      method: 'POST',
      url: `/internal/org/organisations/${org.id}/groups/${group.id}/members?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        userId: member.id,
        isAdmin: true,
      },
    });
    expect(addResponse.statusCode).toBe(200);
    const added = addResponse.json() as { id: string; groupId: string; userId: string; isAdmin: boolean };
    expect(added.groupId).toBe(group.id);
    expect(added.userId).toBe(member.id);
    expect(added.isAdmin).toBe(true);

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/internal/org/organisations/${org.id}/groups/${group.id}/members/${member.id}?domain=${encodeURIComponent(
        testDomain,
      )}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: { isAdmin: false },
    });
    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { id: string; isAdmin: boolean };
    expect(updated.id).toBe(added.id);
    expect(updated.isAdmin).toBe(false);

    const removeResponse = await app.inject({
      method: 'DELETE',
      url: `/internal/org/organisations/${org.id}/groups/${group.id}/members/${member.id}?domain=${encodeURIComponent(
        testDomain,
      )}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(removeResponse.json()).toEqual({ removed: true });

    const remaining = await handle!.prisma.groupMember.findMany({ where: { groupId: group.id } });
    expect(remaining).toHaveLength(0);

    await app.close();
  });

  it('assigns and unassigns teams through internal team-group endpoint', async () => {
    await stubValidInternalConfig(process.env.SHARED_SECRET!, true);

    const owner = await createTestUser(handle!, 'owner@example.com');
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: testDomain,
        name: 'Acme Internal Org',
        slug: 'acme-internal-org-teams',
        ownerId: owner.id,
      },
      select: { id: true },
    });
    const group = await handle!.prisma.group.create({
      data: {
        orgId: org.id,
        name: 'Eng',
        description: 'Engineering',
      },
      select: { id: true },
    });
    const team = await handle!.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Platform',
        description: 'Platform team',
      },
      select: { id: true },
    });

    const domainHash = createClientId(testDomain, process.env.SHARED_SECRET!);
    const app = await createApp();
    await app.ready();

    const assignResponse = await app.inject({
      method: 'PUT',
      url: `/internal/org/organisations/${org.id}/teams/${team.id}/group?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: { groupId: group.id },
    });
    expect(assignResponse.statusCode).toBe(200);
    const assigned = assignResponse.json() as { id: string; groupId: string | null };
    expect(assigned.id).toBe(team.id);
    expect(assigned.groupId).toBe(group.id);

    const unassignResponse = await app.inject({
      method: 'PUT',
      url: `/internal/org/organisations/${org.id}/teams/${team.id}/group?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: { groupId: null },
    });
    expect(unassignResponse.statusCode).toBe(200);
    const unassigned = unassignResponse.json() as { id: string; groupId: string | null };
    expect(unassigned.id).toBe(team.id);
    expect(unassigned.groupId).toBeNull();

    const persistedTeam = await handle!.prisma.team.findFirst({ where: { id: team.id } });
    expect(persistedTeam).not.toBeNull();
    expect(persistedTeam?.groupId).toBeNull();

    await app.close();
  });

  it('returns 404 when group features are disabled', async () => {
    await stubValidInternalConfig(process.env.SHARED_SECRET!, false);

    const owner = await createTestUser(handle!, 'owner@example.com');
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: testDomain,
        name: 'Acme Internal Org',
        slug: 'acme-internal-org-disabled',
        ownerId: owner.id,
      },
      select: { id: true },
    });

    const domainHash = createClientId(testDomain, process.env.SHARED_SECRET!);
    const app = await createApp();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/internal/org/organisations/${org.id}/groups?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        name: 'Disabled Team Group',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('requires a valid domain hash token for internal org routes', async () => {
    await stubValidInternalConfig(process.env.SHARED_SECRET!, true);

    const owner = await createTestUser(handle!, 'owner@example.com');
    const member = await createTestUser(handle!, 'member@example.com');
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: testDomain,
        name: 'Acme Internal Org',
        slug: 'acme-internal-org-auth',
        ownerId: owner.id,
      },
      select: { id: true },
    });
    const group = await handle!.prisma.group.create({
      data: {
        orgId: org.id,
        name: 'Auth Group',
      },
      select: { id: true },
    });
    const team = await handle!.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Auth Team',
      },
      select: { id: true },
    });

    const app = await createApp();
    await app.ready();

    const requests: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: Record<string, unknown> }> = [
      {
        method: 'POST',
        url: `/internal/org/organisations/${org.id}/groups?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
        payload: { name: 'New Group' },
      },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${org.id}/groups/${group.id}?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
        payload: { name: 'Updated Group' },
      },
      {
        method: 'DELETE',
        url: `/internal/org/organisations/${org.id}/groups/${group.id}?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
      },
      {
        method: 'POST',
        url: `/internal/org/organisations/${org.id}/groups/${group.id}/members?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
        payload: { userId: member.id },
      },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${org.id}/groups/${group.id}/members/${member.id}?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
        payload: { isAdmin: true },
      },
      {
        method: 'DELETE',
        url: `/internal/org/organisations/${org.id}/groups/${group.id}/members/${member.id}?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
      },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${org.id}/teams/${team.id}/group?domain=${encodeURIComponent(testDomain)}&config_url=${encodeURIComponent(
          configUrl,
        )}`,
        payload: { groupId: group.id },
      },
    ];

    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { authorization: 'Bearer invalid' },
        ...(request.payload ? { payload: request.payload } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Request failed' });
    }

    await app.close();
  });
});
