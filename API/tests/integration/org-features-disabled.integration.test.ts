import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';

const sampleDomain = 'client.example.com';
const sampleConfigUrl = 'https://client.example.com/auth-config';

describe.skipIf(!hasDatabase)('org features disabled behaviour', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAuthServiceIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;

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
    process.env.AUTH_SERVICE_IDENTIFIER = originalAuthServiceIdentifier;

    if (handle) {
      await handle.cleanup();
    }
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;
    await clearOrgTestDatabase(handle);
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllMocks();
    vi.restoreAllMocks();
  });

  it('returns 404 for /org and /internal/org endpoints when org_features is disabled', async () => {
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, { enabled: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const user = await createTestUser(handle!, 'no-org-features@example.com');
    const actorToken = await signAccessToken({
      subject: user.id,
      domain: sampleDomain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId(sampleDomain, process.env.SHARED_SECRET!);
    const headers = {
      authorization: `Bearer ${domainHash}`,
      'x-uoa-access-token': `Bearer ${actorToken}`,
    };
    const configQuery = `domain=${encodeURIComponent(sampleDomain)}&config_url=${encodeURIComponent(sampleConfigUrl)}`;
    const orgId = 'org-disabled';
    const teamId = 'team-disabled';
    const groupId = 'group-disabled';

    const userFacingOrgEndpoints = [
      { method: 'GET', url: `/org/organisations?${configQuery}` },
      { method: 'POST', url: `/org/organisations?${configQuery}`, payload: { name: 'Ignored org' } },
      { method: 'GET', url: `/org/organisations/${orgId}?${configQuery}` },
      { method: 'PUT', url: `/org/organisations/${orgId}?${configQuery}`, payload: { name: 'Ignored update' } },
      { method: 'DELETE', url: `/org/organisations/${orgId}?${configQuery}` },
      { method: 'GET', url: `/org/organisations/${orgId}/members?${configQuery}` },
      { method: 'POST', url: `/org/organisations/${orgId}/members?${configQuery}`, payload: { userId: user.id } },
      { method: 'PUT', url: `/org/organisations/${orgId}/members/${user.id}?${configQuery}`, payload: { role: 'admin' } },
      { method: 'DELETE', url: `/org/organisations/${orgId}/members/${user.id}?${configQuery}` },
      {
        method: 'POST',
        url: `/org/organisations/${orgId}/transfer-ownership?${configQuery}`,
        payload: { newOwnerId: user.id },
      },
      {
        method: 'POST',
        url: `/org/organisations/${orgId}/ownership-transfer?${configQuery}`,
        payload: { newOwnerId: user.id },
      },
      { method: 'GET', url: `/org/organisations/${orgId}/teams?${configQuery}` },
      { method: 'POST', url: `/org/organisations/${orgId}/teams?${configQuery}`, payload: { name: 'Ignored team' } },
      { method: 'GET', url: `/org/organisations/${orgId}/teams/${teamId}?${configQuery}` },
      { method: 'PUT', url: `/org/organisations/${orgId}/teams/${teamId}?${configQuery}`, payload: { name: 'Ignored team update' } },
      { method: 'DELETE', url: `/org/organisations/${orgId}/teams/${teamId}?${configQuery}` },
      {
        method: 'GET',
        url: `/org/organisations/${orgId}/teams/${teamId}/members?${configQuery}`,
      },
      {
        method: 'POST',
        url: `/org/organisations/${orgId}/teams/${teamId}/members?${configQuery}`,
        payload: { userId: user.id },
      },
      {
        method: 'PUT',
        url: `/org/organisations/${orgId}/teams/${teamId}/members/${user.id}?${configQuery}`,
        payload: { teamRole: 'lead' },
      },
      { method: 'DELETE', url: `/org/organisations/${orgId}/teams/${teamId}/members/${user.id}?${configQuery}` },
      { method: 'GET', url: `/org/organisations/${orgId}/groups?${configQuery}` },
      { method: 'GET', url: `/org/organisations/${orgId}/groups/${groupId}?${configQuery}` },
      { method: 'GET', url: `/org/me?${configQuery}` },
    ];

    const internalOrgEndpoints = [
      { method: 'POST', url: `/internal/org/organisations/${orgId}/groups?${configQuery}`, payload: { name: 'Ignored group' } },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${orgId}/groups/${groupId}?${configQuery}`,
        payload: { name: 'Ignored group update' },
      },
      { method: 'DELETE', url: `/internal/org/organisations/${orgId}/groups/${groupId}?${configQuery}` },
      {
        method: 'POST',
        url: `/internal/org/organisations/${orgId}/groups/${groupId}/members?${configQuery}`,
        payload: { userId: user.id },
      },
      {
        method: 'DELETE',
        url: `/internal/org/organisations/${orgId}/groups/${groupId}/members/${user.id}?${configQuery}`,
      },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${orgId}/groups/${groupId}/members/${user.id}?${configQuery}`,
        payload: { isAdmin: true },
      },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${orgId}/teams/${teamId}/group?${configQuery}`,
        payload: { groupId },
      },
    ];

    for (const endpoint of [...userFacingOrgEndpoints, ...internalOrgEndpoints]) {
      const response = await app.inject({
        method: endpoint.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
        url: endpoint.url,
        headers,
        ...(endpoint.payload ? { payload: endpoint.payload } : {}),
      });
      expect(response.statusCode).toBe(404);
    }

    await app.close();
  });

  it('omits org claim from access token when org_features is disabled', async () => {
    const password = 'Abcdef1!';
    const passwordHash = await hashPassword(password);
    const user = await handle!.prisma.user.create({
      data: {
        email: 'org-disabled-user@example.com',
        userKey: 'org-disabled-user@example.com',
        passwordHash,
      },
      select: { id: true },
    });

    const org = await handle!.prisma.organisation.create({
      data: {
        domain: sampleDomain,
        name: 'Disabled Org',
        slug: 'disabled-org',
        ownerId: user.id,
      },
      select: { id: true },
    });
    await handle!.prisma.orgMember.create({
      data: {
        orgId: org.id,
        userId: user.id,
        role: 'owner',
      },
    });

    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, { enabled: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const loginRes = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(sampleConfigUrl)}`,
      payload: {
        email: 'org-disabled-user@example.com',
        password,
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const { code } = loginRes.json() as { code: string };

    const tokenRes = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(sampleConfigUrl)}`,
      headers: {
        authorization: `Bearer ${createClientId(sampleDomain, process.env.SHARED_SECRET!)}`,
      },
      payload: { code },
    });
    expect(tokenRes.statusCode).toBe(200);

    const tokenBody = tokenRes.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');

    const { payload } = await jwtVerify(tokenBody.access_token, new TextEncoder().encode(process.env.SHARED_SECRET!), {
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    expect(payload.org).toBeUndefined();
    expect(payload.sub).toBe(user.id);

    await app.close();
  });
});
