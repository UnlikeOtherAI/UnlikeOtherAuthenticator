import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import { clearOrgTestDatabase, createSignedConfigJwt, createTestUser, hasDatabase, OrgRecord, signAccessToken } from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('user-facing /org organisations IDOR prevention', () => {
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

  it('rejects access to orgs from another domain when domain context is current domain', async () => {
    const domainA = 'idor-cross-domain-a.example.com';
    const domainB = 'idor-cross-domain-b.example.com';
    const orgConfigUrl = 'https://idor-cross-domain.example.com/auth-config';

    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const actorA = await createTestUser(handle!, 'cross-domain-actor-a@example.com');
    const ownerB = await createTestUser(handle!, 'cross-domain-owner-b@example.com');

    const actorTokenA = await signAccessToken({
      subject: actorA.id,
      domain: domainA,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });
    const ownerTokenB = await signAccessToken({
      subject: ownerB.id,
      domain: domainB,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainAHash = createClientId(domainA, process.env.SHARED_SECRET!);
    const domainBHash = createClientId(domainB, process.env.SHARED_SECRET!);

    const createOrgB = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domainB)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainBHash}`,
        'x-uoa-access-token': `Bearer ${ownerTokenB}`,
      },
      payload: { name: 'Target org B' },
    });
    expect(createOrgB.statusCode).toBe(200);
    const orgB = createOrgB.json() as OrgRecord;

    const crossDomainRes = await app.inject({
      method: 'GET',
      url: `/org/organisations/${orgB.id}?domain=${encodeURIComponent(domainA)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainAHash}`,
        'x-uoa-access-token': `Bearer ${actorTokenA}`,
      },
    });

    expect(crossDomainRes.statusCode).toBe(404);

    await app.close();
  });

  it('rejects org-scoped operations against a different org in same domain', async () => {
    const domain = 'idor-cross-org.example.com';
    const orgConfigUrl = 'https://idor-cross-org.example.com/auth-config';

    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const orgAOwner = await createTestUser(handle!, 'cross-org-owner-a@example.com');
    const orgBOwner = await createTestUser(handle!, 'cross-org-owner-b@example.com');

    const orgAOwnerBaseToken = await signAccessToken({
      subject: orgAOwner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });
    const orgBOwnerBaseToken = await signAccessToken({
      subject: orgBOwner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);

    const createOrgAResponse = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${orgAOwnerBaseToken}`,
      },
      payload: { name: 'Cross-org source' },
    });
    expect(createOrgAResponse.statusCode).toBe(200);

    const createOrgB = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${orgBOwnerBaseToken}`,
      },
      payload: { name: 'Cross-org target' },
    });
    expect(createOrgB.statusCode).toBe(200);
    const orgB = createOrgB.json() as OrgRecord;

    const crossOrgRes = await app.inject({
      method: 'POST',
      url: `/org/organisations/${orgB.id}/teams?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${orgAOwnerBaseToken}`,
      },
      payload: { name: 'Blocked Team' },
    });

    expect(crossOrgRes.statusCode).toBe(403);

    await app.close();
  });

  it('rejects access when access-token domain claim does not match requested domain', async () => {
    const domainA = 'idor-claim-a.example.com';
    const domainB = 'idor-claim-b.example.com';
    const orgConfigUrl = 'https://idor-claim.example.com/auth-config';

    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const actorA = await createTestUser(handle!, 'domain-claim-a@example.com');
    const ownerB = await createTestUser(handle!, 'domain-claim-b@example.com');

    const tokenA = await signAccessToken({
      subject: actorA.id,
      domain: domainA,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });
    const ownerBBaseToken = await signAccessToken({
      subject: ownerB.id,
      domain: domainB,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainBHash = createClientId(domainB, process.env.SHARED_SECRET!);

    const createOrgB = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domainB)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainBHash}`,
        'x-uoa-access-token': `Bearer ${ownerBBaseToken}`,
      },
      payload: { name: 'Claim domain target org' },
    });
    expect(createOrgB.statusCode).toBe(200);
    const orgB = createOrgB.json() as OrgRecord;

    const mismatchRes = await app.inject({
      method: 'GET',
      url: `/org/organisations/${orgB.id}?domain=${encodeURIComponent(domainB)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainBHash}`,
        'x-uoa-access-token': `Bearer ${tokenA}`,
      },
    });

    expect(mismatchRes.statusCode).toBe(403);

    await app.close();
  });
});
