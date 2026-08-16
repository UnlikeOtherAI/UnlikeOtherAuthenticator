import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';
import { verifyIssuedAccessToken } from '../helpers/access-token.js';

const sampleDomain = 'client.example.com';
const sampleConfigUrl = 'https://client.example.com/auth-config';
const adminDomain = 'admin.example.com';
const adminTokenSecret = 'test-admin-token-secret-with-enough-length';
const pkceVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

describe.skipIf(!hasDatabase)('org features disabled behaviour', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAuthServiceIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalAdminSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;

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
    process.env.ADMIN_AUTH_DOMAIN = originalAdminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = originalAdminSecret;

    if (handle) {
      await handle.cleanup();
    }
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminTokenSecret;

    if (!handle) return;
    await clearOrgTestDatabase(handle);
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 404 for /org and /internal/org endpoints when org_features is disabled', async () => {
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, { enabled: false });
    // A fresh Response per call: Response bodies are single-use, and multiple
    // requests (plus app startup) fetch the config through this stub.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(configJwt, { status: 200 })),
    );

    const user = await createTestUser(handle!, 'no-org-features@example.com');
    const actorToken = await signAccessToken({
      subject: user.id,
      domain: sampleDomain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = await seedDomainSecret(handle!.prisma, sampleDomain);
    const headers = {
      authorization: `Bearer ${domainHash}`,
      'x-uoa-access-token': `Bearer ${actorToken}`,
    };

    // /internal/org routes sit behind requireAdminSuperuser, so they need an
    // admin bearer (signed with ADMIN_ACCESS_TOKEN_SECRET for a SUPERUSER on
    // the admin auth domain) to reach the org-features gate that returns 404.
    const adminUser = await createTestUser(handle!, 'internal-admin-disabled@example.com');
    await handle!.prisma.domainRole.create({
      data: { domain: adminDomain, userId: adminUser.id, role: 'SUPERUSER' },
    });
    const adminToken = await signAccessToken({
      subject: adminUser.id,
      email: 'internal-admin-disabled@example.com',
      domain: adminDomain,
      secret: adminTokenSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      role: 'superuser',
    });
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const configQuery = `domain=${encodeURIComponent(sampleDomain)}&config_url=${encodeURIComponent(sampleConfigUrl)}`;
    const orgId = 'org-disabled';
    const teamId = 'team-disabled';
    const groupId = 'group-disabled';

    const userFacingOrgEndpoints = [
      { method: 'GET', url: `/org/organisations?${configQuery}` },
      {
        method: 'POST',
        url: `/org/organisations?${configQuery}`,
        payload: { name: 'Ignored org' },
      },
      { method: 'GET', url: `/org/organisations/${orgId}?${configQuery}` },
      {
        method: 'PUT',
        url: `/org/organisations/${orgId}?${configQuery}`,
        payload: { name: 'Ignored update' },
      },
      { method: 'DELETE', url: `/org/organisations/${orgId}?${configQuery}` },
      { method: 'GET', url: `/org/organisations/${orgId}/members?${configQuery}` },
      {
        method: 'POST',
        url: `/org/organisations/${orgId}/members?${configQuery}`,
        payload: { userId: user.id },
      },
      {
        method: 'PUT',
        url: `/org/organisations/${orgId}/members/${user.id}?${configQuery}`,
        payload: { role: 'admin' },
      },
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
      {
        method: 'POST',
        url: `/org/organisations/${orgId}/teams?${configQuery}`,
        payload: { name: 'Ignored team' },
      },
      { method: 'GET', url: `/org/organisations/${orgId}/teams/${teamId}?${configQuery}` },
      {
        method: 'PUT',
        url: `/org/organisations/${orgId}/teams/${teamId}?${configQuery}`,
        payload: { name: 'Ignored team update' },
      },
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
      {
        method: 'DELETE',
        url: `/org/organisations/${orgId}/teams/${teamId}/members/${user.id}?${configQuery}`,
      },
      { method: 'GET', url: `/org/organisations/${orgId}/groups?${configQuery}` },
      { method: 'GET', url: `/org/organisations/${orgId}/groups/${groupId}?${configQuery}` },
      { method: 'GET', url: `/org/me?${configQuery}` },
    ];

    const internalOrgEndpoints = [
      {
        method: 'POST',
        url: `/internal/org/organisations/${orgId}/groups?${configQuery}`,
        payload: { name: 'Ignored group' },
      },
      {
        method: 'PUT',
        url: `/internal/org/organisations/${orgId}/groups/${groupId}?${configQuery}`,
        payload: { name: 'Ignored group update' },
      },
      {
        method: 'DELETE',
        url: `/internal/org/organisations/${orgId}/groups/${groupId}?${configQuery}`,
      },
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

    const requests = [
      ...userFacingOrgEndpoints.map((endpoint) => ({ ...endpoint, headers })),
      ...internalOrgEndpoints.map((endpoint) => ({ ...endpoint, headers: adminHeaders })),
    ];
    for (const endpoint of requests) {
      const response = await app.inject({
        method: endpoint.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
        url: endpoint.url,
        headers: endpoint.headers,
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
    // A fresh Response per call: Response bodies are single-use, and multiple
    // requests (plus app startup) fetch the config through this stub.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(configJwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const loginRes = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(sampleConfigUrl)}&code_challenge=${pkceChallenge(pkceVerifier)}&code_challenge_method=S256`,
      payload: {
        email: 'org-disabled-user@example.com',
        password,
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const { code } = loginRes.json() as { code: string };

    const domainHash = await seedDomainSecret(handle!.prisma, sampleDomain);
    const tokenRes = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(sampleConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        code,
        redirect_url: 'https://client.example.com/oauth/callback',
        code_verifier: pkceVerifier,
      },
    });
    expect(tokenRes.statusCode).toBe(200);

    const tokenBody = tokenRes.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');

    const payload = await verifyIssuedAccessToken(tokenBody.access_token);

    expect(payload.org).toBeUndefined();
    expect(payload.sub).toBe(user.id);

    await app.close();
  });
});
