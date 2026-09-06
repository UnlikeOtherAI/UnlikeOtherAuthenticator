import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  checkOrgSlugAvailability,
  resolveOrgById,
  resolveOrgHostname,
  resolveTeamById,
  resolveTeamHostname,
} from '../../src/services/team-hostname.service.js';
import { PrismaClient } from '@prisma/client';

import { createRlsTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const DOMAIN = 'client.example.com';

/**
 * These call the hostname service WITHOUT injecting a prisma client, which is
 * the whole point.
 *
 * The unit tests all pass `deps.prisma`, so they exercised the query shapes and
 * never the client that runs them — and the service was reaching for the
 * tenant-scoped client on routes that have no tenant context. `organisations`
 * and `teams` have FORCE ROW LEVEL SECURITY, so every read matched zero rows.
 * It did not throw: resolution answered "no such tenant" and availability
 * answered "available" for slugs that were plainly taken, in production, for as
 * long as the feature existed.
 *
 * A mocked client cannot see that. Only a real one can.
 */
describe.skipIf(!hasDatabase)('hostname reads run against real row-level security', () => {
  let handle: Awaited<ReturnType<typeof createRlsTestDb>>;
  let appPrisma: PrismaClient;
  let adminPrisma: PrismaClient;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    handle = await createRlsTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    // `uoa_app` is the non-BYPASSRLS role the API runs as; `uoa_admin` is the
    // BYPASSRLS role `DATABASE_ADMIN_URL` names in production, which is what a
    // domain-hash route must use. Seeding stays on handle.prisma (superuser).
    appPrisma = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    adminPrisma = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    await appPrisma?.$disconnect();
    await adminPrisma?.$disconnect();
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  const seed = async () => {
    const owner = await handle.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain: DOMAIN, name: 'Acme', slug: 'acme', ownerId: owner.id },
      select: { id: true },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Design', slug: 'design' },
      select: { id: true },
    });
    return { orgId: org.id, teamId: team.id };
  };

  it('finds an organisation by its slug', async () => {
    const { orgId } = await seed();
    const resolved = await resolveOrgHostname({ domain: DOMAIN, orgSlug: 'acme' }, { prisma: adminPrisma });
    expect(resolved).toMatchObject({ orgId, orgSlug: 'acme', orgName: 'Acme' });
  });

  it('finds a team beneath its organisation', async () => {
    const { orgId, teamId } = await seed();
    const resolved = await resolveTeamHostname(
      { domain: DOMAIN, orgSlug: 'acme', teamSlug: 'design' },
      { prisma: adminPrisma },
    );
    expect(resolved).toMatchObject({ orgId, teamId, teamSlug: 'design' });
  });

  it('reports a taken slug as taken, not as available', async () => {
    await seed();
    // The exact failure this file exists for: with no rows visible, this
    // answered `available: true` and would have let a second tenant be told a
    // taken address was free.
    expect(await checkOrgSlugAvailability({ domain: DOMAIN, slug: 'acme' }, { prisma: adminPrisma })).toEqual({
      available: false,
      reason: 'taken',
    });
  });

  it('resolves an address back from an id', async () => {
    const { orgId, teamId } = await seed();
    expect(await resolveOrgById({ domain: DOMAIN, orgId }, { prisma: adminPrisma })).toMatchObject({ orgSlug: 'acme' });
    expect(await resolveTeamById({ domain: DOMAIN, teamId }, { prisma: adminPrisma })).toMatchObject({
      teamSlug: 'design',
      orgSlug: 'acme',
    });
  });

  it('still refuses another client domain, which is now the only boundary', async () => {
    const { orgId, teamId } = await seed();
    // The tenant-scoped client is gone, so the domain predicate is what keeps
    // one product out of another's tenants. Prove it holds.
    expect(await resolveOrgHostname({ domain: 'other.example.com', orgSlug: 'acme' }, { prisma: adminPrisma })).toBeNull();
    expect(await resolveOrgById({ domain: 'other.example.com', orgId }, { prisma: adminPrisma })).toBeNull();
    expect(await resolveTeamById({ domain: 'other.example.com', teamId }, { prisma: adminPrisma })).toBeNull();
    expect(
      await checkOrgSlugAvailability({ domain: 'other.example.com', slug: 'acme' }, { prisma: adminPrisma }),
    ).toEqual({ available: true, slug: 'acme' });
  });

  it('the runtime RLS role sees nothing here — which is the bug that shipped', async () => {
    await seed();
    // `uoa_app` cannot satisfy any branch of organisations_select on a
    // domain-hash route: there is no app.org_id, no app.user_id, and the
    // domain branch additionally requires an org_members row for that user.
    // It does not error, it returns nothing — so resolution answered 404 and
    // availability answered "available" for a slug that was taken.
    expect(
      await resolveOrgHostname({ domain: DOMAIN, orgSlug: 'acme' }, { prisma: appPrisma }),
    ).toBeNull();
    expect(
      await checkOrgSlugAvailability({ domain: DOMAIN, slug: 'acme' }, { prisma: appPrisma }),
    ).toEqual({ available: true, slug: 'acme' });
  });
});
