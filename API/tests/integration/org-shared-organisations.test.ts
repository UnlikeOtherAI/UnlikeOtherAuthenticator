import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestConfigFetchHandler } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
  type OrgRecord,
  type TeamRecord,
} from '../helpers/org-user-endpoints-helper.js';

/**
 * One organisation, every UOA-integrated product.
 *
 * An org is CREATED on one product's domain and keeps that as its origin, but the
 * `/org/organisations/:orgId/**` management surface no longer treats the origin as an
 * authorization predicate for user-token calls. The gates are the ones that survive: the guard's
 * token-domain and org-claim checks, and live ACTIVE membership in the services.
 *
 * Backend / domain-hash-only mode is the exception and stays origin-scoped, so the last case here
 * pins that a domain backend still cannot reach another product's org.
 */
describe.skipIf(!hasDatabase)('organisations shared across UOA-integrated products', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  const domainA = 'shared-orgs-origin.example.com';
  const domainB = 'shared-orgs-consumer.example.com';
  const configUrlA = `https://${domainA}/auth-config`;
  const configUrlB = `https://${domainB}/auth-config`;

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

  async function setUp() {
    const secret = process.env.SHARED_SECRET!;
    const issuer = process.env.AUTH_SERVICE_IDENTIFIER!;

    const configJwtA = await createSignedConfigJwt(secret, { allow_user_create_org: true }, domainA);
    const configJwtB = await createSignedConfigJwt(
      secret,
      { allow_user_create_org: true, backend_org_management: true },
      domainB,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(await createTestConfigFetchHandler({ [configUrlA]: configJwtA, [configUrlB]: configJwtB })),
    );

    const owner = await createTestUser(handle!, 'shared-orgs-owner@example.com');

    const app = await createApp();
    await app.ready();

    const hashA = await seedDomainSecret(handle!.prisma, domainA);
    const hashB = await seedDomainSecret(handle!.prisma, domainB);

    const tokenOnA = await signAccessToken({ subject: owner.id, domain: domainA, secret, issuer });

    // Org A is created on its origin domain, the only place `POST /org/organisations` runs.
    const createdOrg = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domainA)}&config_url=${encodeURIComponent(configUrlA)}`,
      headers: { authorization: `Bearer ${hashA}`, 'x-uoa-access-token': `Bearer ${tokenOnA}` },
      payload: { name: 'Shared org' },
    });
    expect(createdOrg.statusCode).toBe(200);
    const org = createdOrg.json() as OrgRecord;

    const ownerOnA = await signAccessToken({
      subject: owner.id,
      domain: domainA,
      secret,
      issuer,
      org: { orgId: org.id, orgRole: 'owner' },
    });

    const createdTeam = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams?domain=${encodeURIComponent(domainA)}&config_url=${encodeURIComponent(configUrlA)}`,
      headers: { authorization: `Bearer ${hashA}`, 'x-uoa-access-token': `Bearer ${ownerOnA}` },
      payload: { name: 'Origin team' },
    });
    expect(createdTeam.statusCode).toBe(200);
    const team = createdTeam.json() as TeamRecord;

    // The same human, arriving from the OTHER product. The token's `domain` is domain B — which is
    // what the guard matches against `?domain=` — while its `org` claim still names org A.
    const ownerOnB = await signAccessToken({
      subject: owner.id,
      domain: domainB,
      secret,
      issuer,
      org: { orgId: org.id, orgRole: 'owner', teams: [team.id], team_roles: { [team.id]: 'owner' } },
    });

    return { app, org, team, owner, hashA, hashB, ownerOnB, secret, issuer };
  }

  function fromB(hashB: string, token: string) {
    return {
      query: `domain=${encodeURIComponent(domainB)}&config_url=${encodeURIComponent(configUrlB)}`,
      headers: { authorization: `Bearer ${hashB}`, 'x-uoa-access-token': `Bearer ${token}` },
    };
  }

  it('serves the whole management surface for an org another product created', async () => {
    const { app, org, team, hashB, ownerOnB } = await setUp();
    const { query, headers } = fromB(hashB, ownerOnB);

    const readOrg = await app.inject({ method: 'GET', url: `/org/organisations/${org.id}?${query}`, headers });
    expect(readOrg.statusCode).toBe(200);
    // The record still reports its ORIGIN domain — the org moved surface, not owner.
    expect(readOrg.json()).toMatchObject({ id: org.id, domain: domainA });

    const listTeams = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/teams?${query}`,
      headers,
    });
    expect(listTeams.statusCode).toBe(200);
    expect((listTeams.json() as { data: TeamRecord[] }).data.map((t) => t.id)).toContain(team.id);

    const readTeam = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/teams/${team.id}?${query}`,
      headers,
    });
    expect(readTeam.statusCode).toBe(200);
    expect(readTeam.json()).toMatchObject({ id: team.id, orgId: org.id });

    const listMembers = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/members?${query}`,
      headers,
    });
    expect(listMembers.statusCode).toBe(200);

    const createTeam = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams?${query}`,
      headers,
      payload: { name: 'Team created from the other product' },
    });
    expect(createTeam.statusCode).toBe(200);
    expect(createTeam.json()).toMatchObject({ orgId: org.id });

    await app.close();
  });

  it('refuses an org the token is not scoped to — 403 from the guard, not a 404', async () => {
    const { app, hashB, ownerOnB, secret, issuer } = await setUp();

    // A second org, created on domain B by someone else. The caller is not scoped to it, and the
    // refusal must stay a uniform 403 rather than leaking existence through a 404.
    const strangerOnB = await signAccessToken({
      subject: (await createTestUser(handle!, 'shared-orgs-other-owner@example.com')).id,
      domain: domainB,
      secret,
      issuer,
    });
    const otherOrgRes = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domainB)}&config_url=${encodeURIComponent(configUrlB)}`,
      headers: { authorization: `Bearer ${hashB}`, 'x-uoa-access-token': `Bearer ${strangerOnB}` },
      payload: { name: 'Someone else org' },
    });
    expect(otherOrgRes.statusCode).toBe(200);
    const otherOrg = otherOrgRes.json() as OrgRecord;

    const { query, headers } = fromB(hashB, ownerOnB);
    const denied = await app.inject({
      method: 'GET',
      url: `/org/organisations/${otherOrg.id}?${query}`,
      headers,
    });
    expect(denied.statusCode).toBe(403);

    await app.close();
  });

  it('keeps backend mode scoped to the org origin domain: 404 for another product org', async () => {
    const { app, org, hashB } = await setUp();

    // No `x-uoa-access-token` at all — the domain pairing alone, with `backend_org_management`
    // opted in on domain B. There is no acting user and no membership to check, so the org's
    // origin domain is the only boundary left, and it must still hold.
    const backend = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}?domain=${encodeURIComponent(domainB)}&config_url=${encodeURIComponent(configUrlB)}`,
      headers: { authorization: `Bearer ${hashB}` },
    });
    expect(backend.statusCode).toBe(404);

    await app.close();
  });
});
