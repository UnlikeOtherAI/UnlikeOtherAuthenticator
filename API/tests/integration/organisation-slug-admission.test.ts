import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { deriveSlugWithValidation, ensureAvailableOrgSlug } from '../../src/services/organisation.service.base.js';
import {
  isOrganisationSlugConflict,
  isOrganisationSlugTaken,
  withAutomaticOrganisationSlug,
  withChosenOrganisationSlug,
} from '../../src/services/organisation-slug-admission.service.js';
import { createRlsTestDb } from '../helpers/test-db.js';

describe('global organisation address admission with PostgreSQL and production RLS', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>;
  let appPrisma: PrismaClient;

  beforeAll(async () => {
    const db = await createRlsTestDb();
    if (!db) throw new Error('DATABASE_URL is required for organisation address admission coverage');
    handle = db;
    appPrisma = new PrismaClient({ datasources: { db: { url: db.appDatabaseUrl } } });
    await appPrisma.$connect();
  });

  afterAll(async () => {
    await appPrisma?.$disconnect();
    await handle?.cleanup();
  });

  const label = () => `org-${randomUUID()}`;
  async function actor() {
    const owner = await handle.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: randomUUID(),
    } });
    return { domain: `${randomUUID()}.example.com`, userId: owner.id };
  }

  async function organisation(context: Awaited<ReturnType<typeof actor>>, slug = label()) {
    return handle.prisma.organisation.create({ data: {
      domain: context.domain, ownerId: context.userId, name: 'Address admission fixture', slug,
    } });
  }

  // Both independent transactions finish their advisory checks before either
  // write. No timer or fake Prisma exception stands in for the database race.
  function rendezvous() {
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    return async () => {
      if (++arrived === 2) release();
      await ready;
    };
  }

  it('admits exactly one concurrent cross-domain create and maps the actual trigger P2002', async () => {
    const contexts = await Promise.all([actor(), actor()]);
    const slug = label();
    const meet = rendezvous();
    const conflicts: unknown[] = [];
    const results = await Promise.allSettled(contexts.map(context => withChosenOrganisationSlug(() =>
      runWithTenantContext({ prisma: appPrisma, context }, async tx => {
        expect(await ensureAvailableOrgSlug({ domain: context.domain, prisma: tx, slug })).toBe(slug);
        await meet();
        return tx.organisation.create({ data: {
          domain: context.domain, ownerId: context.userId, name: 'Concurrent creator', slug,
        } }).catch((error: unknown) => { conflicts.push(error); throw error; });
      }))));

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'BAD_REQUEST', statusCode: 400, message: 'ORG_SLUG_TAKEN' },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: 'P2002', meta: { modelName: 'Organisation' } });
    expect(isOrganisationSlugConflict(conflicts[0])).toBe(true);
    const rows = await handle.prisma.organisation.findMany({ where: { slug }, select: { id: true } });
    expect(rows).toHaveLength(1);
    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug } }))
      .toMatchObject({ orgId: rows[0].id });
  });

  it('serializes concurrent cross-domain renames and preserves the losing address and claim', async () => {
    const contexts = await Promise.all([actor(), actor()]);
    const originals = await Promise.all(contexts.map(context => organisation(context)));
    const slug = label();
    const meet = rendezvous();
    const results = await Promise.allSettled(originals.map((original, index) =>
      withChosenOrganisationSlug(() => runWithTenantContext({ prisma: appPrisma,
        context: { ...contexts[index], orgId: original.id } }, async tx => {
        expect(await ensureAvailableOrgSlug({ domain: contexts[index].domain, prisma: tx, slug })).toBe(slug);
        await meet();
        return tx.organisation.update({ where: { id: original.id }, data: { slug } });
      }))));

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'BAD_REQUEST', statusCode: 400, message: 'ORG_SLUG_TAKEN' },
    });
    for (const [index, original] of originals.entries()) {
      const won = results[index].status === 'fulfilled';
      expect(await handle.prisma.organisation.findUnique({ where: { id: original.id } }))
        .toMatchObject({ slug: won ? slug : original.slug });
      expect(await isOrganisationSlugTaken(handle.prisma, original.slug)).toBe(!won);
    }
    const claim = await handle.prisma.organisationSlugClaim.findUniqueOrThrow({ where: { slug } });
    expect(claim.orgId).toBe(originals[results.findIndex(result => result.status === 'fulfilled')].id);
  });

  it('retries a real concurrent claim inside the automatic allocator savepoint', async () => {
    const contexts = await Promise.all([actor(), actor()]);
    const name = label();
    const meet = rendezvous();
    const conflicts: unknown[] = [];
    const results = await Promise.all(contexts.map(context => {
      const attempted: string[] = [];
      return runWithTenantContext({ prisma: appPrisma, context }, tx =>
        withAutomaticOrganisationSlug(tx, async () => {
          const slug = await deriveSlugWithValidation(context.domain, tx, name);
          attempted.push(slug);
          if (attempted.length === 1) await meet();
          const org = await tx.organisation.create({ data: {
            domain: context.domain, ownerId: context.userId, name, slug,
          } }).catch((error: unknown) => { conflicts.push(error); throw error; });
          return { org, attempted };
        }));
    }));

    expect(results.map(result => result.attempted.length).sort()).toEqual([1, 2]);
    expect(results.every(result => result.attempted[0] === name)).toBe(true);
    expect(new Set(results.map(result => result.org.slug)).size).toBe(2);
    expect(results.some(result => result.org.slug === name)).toBe(true);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: 'P2002', meta: { modelName: 'Organisation' } });
    expect(isOrganisationSlugConflict(conflicts[0])).toBe(true);
    for (const { org } of results) {
      expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: org.slug } }))
        .toMatchObject({ orgId: org.id });
    }
  });

  it('does not turn an unrelated organisation primary-key violation into an address conflict', async () => {
    const context = await actor();
    const original = await organisation(context);
    await expect(withChosenOrganisationSlug(() => handle.prisma.organisation.create({ data: {
      id: original.id, domain: context.domain, ownerId: context.userId, name: 'Duplicate id', slug: label(),
    } }))).rejects.toMatchObject({ code: 'P2002', meta: { modelName: 'Organisation', target: ['id'] } });
  });

  it('lets uoa_app see only occupancy and refuses direct claim insertion, reassignment and deletion', async () => {
    const victim = await organisation(await actor());
    const context = await actor();
    const own = await organisation(context);
    await runWithTenantContext({ prisma: appPrisma, context: { ...context, orgId: own.id } }, async tx => {
      expect(await tx.organisation.findUnique({ where: { id: victim.id } })).toBeNull();
      expect(await isOrganisationSlugTaken(tx, victim.slug)).toBe(true);
      expect(await isOrganisationSlugTaken(tx, label())).toBe(false);
      expect(await tx.$queryRaw`SELECT slug, org_id FROM organisation_slug_claims`).toEqual([]);
      expect(await tx.$executeRaw`UPDATE organisation_slug_claims SET org_id = ${own.id}
        WHERE slug = ${victim.slug}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM organisation_slug_claims WHERE slug = ${victim.slug}`).toBe(0);
    });
    const injected = label();
    await expect(runWithTenantContext({ prisma: appPrisma, context }, tx =>
      tx.$executeRaw`INSERT INTO organisation_slug_claims(slug, org_id) VALUES (${injected}, ${own.id})`,
    )).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    expect(await isOrganisationSlugTaken(handle.prisma, injected)).toBe(false);
    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: victim.slug } }))
      .toMatchObject({ orgId: victim.id });
    await expect(withChosenOrganisationSlug(() => runWithTenantContext({ prisma: appPrisma, context }, tx =>
      tx.organisation.create({ data: { domain: context.domain, ownerId: context.userId,
        name: 'Hidden victim collision', slug: victim.slug } }),
    ))).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400, message: 'ORG_SLUG_TAKEN' });
  });

  it('retains an address through disable and reactivation, releasing it on physical deletion', async () => {
    const victim = await organisation(await actor());
    const other = await actor();
    await handle.prisma.organisation.update({ where: { id: victim.id }, data: { lifecycleStatus: 'DISABLED' } });
    expect(await isOrganisationSlugTaken(handle.prisma, victim.slug)).toBe(true);
    await expect(withChosenOrganisationSlug(() => organisation(other, victim.slug)))
      .rejects.toMatchObject({ message: 'ORG_SLUG_TAKEN' });
    await handle.prisma.organisation.update({ where: { id: victim.id }, data: { lifecycleStatus: 'ACTIVE' } });
    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: victim.slug } }))
      .toMatchObject({ orgId: victim.id });
    await handle.prisma.organisation.delete({ where: { id: victim.id } });
    expect(await isOrganisationSlugTaken(handle.prisma, victim.slug)).toBe(false);
    const replacement = await organisation(other, victim.slug);
    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: victim.slug } }))
      .toMatchObject({ orgId: replacement.id });
  });

  it('cannot obstruct terminal deletion by preclaiming its placeholder from another domain', async () => {
    const victim = await organisation(await actor());
    const other = await actor();
    const placeholder = `deleted-${victim.id}`;
    const blocker = await organisation(other, placeholder);
    await handle.prisma.organisation.update({ where: { id: victim.id }, data: { lifecycleStatus: 'DELETING' } });
    await handle.prisma.organisation.update({ where: { id: victim.id }, data: {
      lifecycleStatus: 'DELETED', slug: placeholder, name: 'Deleted organisation', ownerId: null,
    } });

    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: placeholder } }))
      .toMatchObject({ orgId: blocker.id });
    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: victim.slug } }))
      .toMatchObject({ orgId: victim.id });
    await expect(withChosenOrganisationSlug(() => organisation(other, victim.slug)))
      .rejects.toMatchObject({ message: 'ORG_SLUG_TAKEN' });
    await expect(handle.prisma.organisation.update({ where: { id: victim.id }, data: { lifecycleStatus: 'ACTIVE' } }))
      .rejects.toThrow();
    await handle.prisma.organisation.delete({ where: { id: victim.id } });
    expect(await isOrganisationSlugTaken(handle.prisma, victim.slug)).toBe(false);
    expect(await handle.prisma.organisationSlugClaim.findUnique({ where: { slug: placeholder } }))
      .toMatchObject({ orgId: blocker.id });
  });
});
