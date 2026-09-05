import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const DOMAIN = 'client.example.com';
const CONFIG_URL = 'https://client.example.com/auth-config';
// TIMESTAMP(3) ties are real: a bulk create in one transaction, a restore, or a
// backfill can stamp many rows with the same millisecond. `orderBy: createdAt`
// alone is then a partial order, and Prisma's cursor comparison (a row-value
// tuple over the ordering columns) can no longer identify a resume point —
// rows silently vanish from the walk. Seven rows over pages of two also forces
// four pages, so a mid-walk drop cannot hide in a single-page result.
const TIE_COUNT = 7;
const PAGE_SIZE = 2;

function secretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

async function signOrgAccessToken(params: {
  subject: string;
  orgId: string;
  orgRole?: string;
}): Promise<string> {
  const secret = process.env.SHARED_SECRET!;
  return await new SignJWT({
    email: 'owner@example.com',
    domain: DOMAIN,
    client_id: createClientId(DOMAIN, secret),
    role: 'user',
    org: {
      org_id: params.orgId,
      org_role: params.orgRole ?? 'owner',
      teams: [],
      team_roles: {},
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(process.env.AUTH_SERVICE_IDENTIFIER!)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(params.subject)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(secretKey(secret));
}

type CursorPage = { data: Array<{ id: string }>; next_cursor: string | null };

/**
 * Walk a cursor-paginated list to exhaustion, exactly as a consuming backend
 * does: follow `next_cursor` until it is null. Returns every id the walk saw,
 * in order and including duplicates, so the caller can assert both
 * completeness and uniqueness.
 */
async function walkCursorPages(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  const maxPages = TIE_COUNT + 5;

  for (let page = 0; page < maxPages; page += 1) {
    const url = `${path}&limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await app.inject({ method: 'GET', url, headers });
    expect(res.statusCode).toBe(200);

    const body = res.json() as CursorPage;
    seen.push(...body.data.map((row) => row.id));
    if (!body.next_cursor) return seen;
    cursor = body.next_cursor;
  }

  throw new Error('cursor walk did not terminate');
}

function expectExactlyOnce(seen: string[], expected: string[]): void {
  expect([...seen].sort()).toEqual([...expected].sort());
  expect(new Set(seen).size).toBe(expected.length);
}

describe.skipIf(!hasDatabase)('/org list cursor pagination with created_at ties', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  // One instant shared by every seeded row in a test — the collision the
  // millisecond-resolution column allows.
  const tiedAt = new Date('2026-01-01T00:00:00.000Z');

  let app: Awaited<ReturnType<typeof createApp>>;
  let domainHash: string;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;
    await handle.prisma.groupMember.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.group.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await cleanClientDomains(handle.prisma);

    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        org_features: {
          enabled: true,
          groups_enabled: true,
          // `GET /org/organisations` lists a whole domain with no user token,
          // which is exactly what this flag governs (brief §24.8). The route now
          // runs the same opt-in check as every other backend-mode call.
          backend_org_management: true,
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));

    app = await createApp();
    await app.ready();
    domainHash = await seedDomainSecret(handle.prisma, DOMAIN);
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createOwner(email = 'owner@example.com'): Promise<{ id: string }> {
    return await handle!.prisma.user.create({
      data: { email, userKey: email, passwordHash: null },
      select: { id: true },
    });
  }

  /**
   * An organisation plus its owner's membership row.
   *
   * The membership is not decoration: `createOrganisation` writes one for the
   * founder, and the `/org/*` roster reads re-resolve live membership rather
   * than trusting a token's claims. An organisation whose owner has no
   * OrgMember row is a shape production never produces, and reading its
   * members is correctly refused with 403 — which is what this fixture used to
   * build.
   */
  async function createOrg(
    ownerId: string,
    slug = 'acme',
  ): Promise<{ id: string; ownerMemberId: string }> {
    const org = await handle!.prisma.organisation.create({
      data: { domain: DOMAIN, name: `Acme ${slug}`, slug, ownerId },
      select: { id: true },
    });
    const ownerMember = await handle!.prisma.orgMember.create({
      data: { orgId: org.id, userId: ownerId, role: 'owner' },
      select: { id: true },
    });
    return { id: org.id, ownerMemberId: ownerMember.id };
  }

  it('returns every organisation exactly once when all rows share created_at', async () => {
    const owner = await createOwner();
    const created: string[] = [];
    for (let i = 0; i < TIE_COUNT; i += 1) {
      const org = await handle!.prisma.organisation.create({
        data: {
          domain: DOMAIN,
          name: `Tied Org ${i}`,
          slug: `tied-org-${i}`,
          ownerId: owner.id,
          createdAt: tiedAt,
          updatedAt: tiedAt,
        },
        select: { id: true },
      });
      created.push(org.id);
    }

    const seen = await walkCursorPages(
      app,
      `/org/organisations?domain=${DOMAIN}&config_url=${encodeURIComponent(CONFIG_URL)}`,
      { authorization: `Bearer ${domainHash}` },
    );

    expectExactlyOnce(seen, created);
  });

  it('returns every team exactly once when all rows share created_at', async () => {
    const owner = await createOwner();
    // createOrg gives the owner their membership row; listTeams authorizes the
    // actor as an ACTIVE org member before listing.
    const org = await createOrg(owner.id, 'teams-tie');

    const created: string[] = [];
    for (let i = 0; i < TIE_COUNT; i += 1) {
      const team = await handle!.prisma.team.create({
        data: {
          orgId: org.id,
          name: `Tied Team ${i}`,
          slug: `tied-team-${i}`,
          createdAt: tiedAt,
          updatedAt: tiedAt,
        },
        select: { id: true },
      });
      created.push(team.id);
    }

    const token = await signOrgAccessToken({ subject: owner.id, orgId: org.id });
    const seen = await walkCursorPages(
      app,
      `/org/organisations/${org.id}/teams?domain=${DOMAIN}&config_url=${encodeURIComponent(CONFIG_URL)}`,
      { authorization: `Bearer ${domainHash}`, 'x-uoa-access-token': `Bearer ${token}` },
    );

    expectExactlyOnce(seen, created);
  });

  it('returns every organisation member exactly once when all rows share created_at', async () => {
    const owner = await createOwner();
    const org = await createOrg(owner.id, 'members-tie');

    // The owner's own membership is part of the roster the walk will return.
    const created: string[] = [org.ownerMemberId];
    for (let i = 0; i < TIE_COUNT; i += 1) {
      const user = await createOwner(`tied-member-${i}@example.com`);
      const member = await handle!.prisma.orgMember.create({
        data: {
          orgId: org.id,
          userId: user.id,
          role: 'member',
          createdAt: tiedAt,
          updatedAt: tiedAt,
        },
        select: { id: true },
      });
      created.push(member.id);
    }

    const token = await signOrgAccessToken({ subject: owner.id, orgId: org.id });
    const seen = await walkCursorPages(
      app,
      `/org/organisations/${org.id}/members?domain=${DOMAIN}&config_url=${encodeURIComponent(CONFIG_URL)}`,
      { authorization: `Bearer ${domainHash}`, 'x-uoa-access-token': `Bearer ${token}` },
    );

    expectExactlyOnce(seen, created);
  });

  it('returns every group exactly once when all rows share created_at', async () => {
    const owner = await createOwner();
    const org = await createOrg(owner.id, 'groups-tie');

    const created: string[] = [];
    for (let i = 0; i < TIE_COUNT; i += 1) {
      const group = await handle!.prisma.group.create({
        data: {
          orgId: org.id,
          name: `Tied Group ${i}`,
          createdAt: tiedAt,
          updatedAt: tiedAt,
        },
        select: { id: true },
      });
      created.push(group.id);
    }

    const token = await signOrgAccessToken({ subject: owner.id, orgId: org.id });
    const seen = await walkCursorPages(
      app,
      `/org/organisations/${org.id}/groups?domain=${DOMAIN}&config_url=${encodeURIComponent(CONFIG_URL)}`,
      { authorization: `Bearer ${domainHash}`, 'x-uoa-access-token': `Bearer ${token}` },
    );

    expectExactlyOnce(seen, created);
  });
});
