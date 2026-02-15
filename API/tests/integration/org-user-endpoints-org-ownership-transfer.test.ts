import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  OrgMemberRecord,
  OrgRecord,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('organisation owner transfer before sole-owner removal', () => {
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

  it('blocks removing sole owner until ownership is transferred', async () => {
    const domain = 'org-owner-transfer.example.com';
    const orgConfigUrl = 'https://org-owner-transfer.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'owner-transfer@example.com');
    const secondOwner = await createTestUser(handle!, 'second-owner@example.com');

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
      payload: { name: 'Acme Owner Transfer' },
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

    const addSecondOwner = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { userId: secondOwner.id },
    });
    expect(addSecondOwner.statusCode).toBe(200);

    const removeOwnerFirstAttempt = await app.inject({
      method: 'DELETE',
      url: `/org/organisations/${org.id}/members/${owner.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(removeOwnerFirstAttempt.statusCode).toBe(400);
    expect(removeOwnerFirstAttempt.json()).toEqual({ error: 'Request failed' });

    const transferOwnership = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/transfer-ownership?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { newOwnerId: secondOwner.id },
    });
    expect(transferOwnership.statusCode).toBe(200);
    expect((transferOwnership.json() as OrgRecord).ownerId).toBe(secondOwner.id);

    const removeOriginalOwner = await app.inject({
      method: 'DELETE',
      url: `/org/organisations/${org.id}/members/${owner.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(removeOriginalOwner.statusCode).toBe(200);

    const membersAfterTransfer = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=10`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(membersAfterTransfer.statusCode).toBe(200);
    const members = membersAfterTransfer.json() as { data: OrgMemberRecord[]; next_cursor: string | null };
    expect(members.data).toHaveLength(1);
    expect(members.data[0].userId).toBe(secondOwner.id);

    await app.close();
  });
});
