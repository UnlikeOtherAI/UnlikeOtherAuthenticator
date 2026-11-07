import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb } from '../helpers/test-db.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
import { beginTeamArchive, readTeamArchive } from '../../src/services/team-archive.service.js';
import { assertEntityAccess } from '../../src/services/entity-lifecycle.service.js';
import { reconcileTeamArchives } from '../../src/services/team-archive-reconciliation.service.js';
import { buildSidebarTeams } from '../../src/services/team-directory.service.js';
import { withLiveTeamBillingEffect } from '../../src/services/team-billing-effect.service.js';
import { previewEntityDeletion } from '../../src/services/entity-deletion-preview.service.js';

const domain = 'archive.example.com';
const store = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => store.prisma!, getPrisma: () => store.prisma! }));

describe.skipIf(!process.env.DATABASE_URL)('held team archive on PostgreSQL', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>;
  const original = process.env.DATABASE_URL;
  beforeAll(async () => { db = (await createRlsTestDb())!; store.prisma = db.prisma; process.env.DATABASE_URL = db.databaseUrl; });
  afterAll(async () => { process.env.DATABASE_URL = original; await db?.cleanup(); });

  async function seed(options?: { role?: string; sibling?: boolean }) {
    const owner = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const org = await db.prisma.organisation.create({ data: { domain, name: 'Studio', slug: randomUUID(), ownerId: owner.id } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Design', slug: randomUUID(), isDefault: true } });
    const sibling = options?.sibling ? await db.prisma.team.create({ data: { orgId: org.id, name: 'Other', slug: randomUUID() } }) : null;
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: options?.role ?? 'admin' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id } });
    if (sibling) await db.prisma.teamMember.create({ data: { teamId: sibling.id, userId: owner.id } });
    const token = 'a'.repeat(64);
    const client = await db.prisma.clientDomain.upsert({ where: { domain }, create: { domain, label: 'Archive test' }, update: {} });
    if (!await db.prisma.clientDomainSecret.findFirst({ where: { domainId: client.id } })) {
      await db.prisma.clientDomainSecret.create({ data: { domainId: client.id, secretDigest: digestDomainClientHash(token), hashPrefix: token.slice(0, 16) } });
    }
    const claims = { userId: owner.id, tokenVersion: owner.tokenVersion, email: owner.email!, clientId: token,
      role: 'user' as const, domain, org: { org_id: org.id, org_role: options?.role ?? 'admin', teams: [team.id], team_roles: {} },
      active: { orgId: org.id, teamId: team.id } };
    const params = { id: randomUUID(), orgId: org.id, teamId: team.id, claims, domain,
      domainToken: token, config: validateConfigFields(baseClientConfigPayload({ domain })) };
    return { owner, org, team, sibling, params, client };
  }

  it('archives the default and last team without erasing the organisation or people', async () => {
    const { owner, org, team, params, client } = await seed();
    const receipt = await beginTeamArchive(params, { prisma: db.prisma });
    expect(receipt).toMatchObject({ status: 'STOPPING_BILLING', deletion_held: true, permanently_deleted: false });
    expect((await db.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).lifecycleStatus).toBe('ARCHIVED');
    expect((await db.prisma.organisation.findUniqueOrThrow({ where: { id: org.id } })).lifecycleStatus).toBe('ACTIVE');
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).tokenVersion).toBe(owner.tokenVersion);
    await expect(assertEntityAccess({ userId: owner.id, teamId: team.id }, db.prisma)).rejects.toThrow('ACCESS_DENIED');
    expect(await buildSidebarTeams({ userId: owner.id, domain }, { prisma: db.prisma })).toEqual([]);
    expect(await db.prisma.entityDeletionJob.count()).toBe(0);
    await expect(db.prisma.team.update({ where: { id: team.id }, data: { lifecycleStatus: 'ACTIVE' } })).rejects.toThrow('deletion is held');
    await expect(db.prisma.team.delete({ where: { id: team.id } })).rejects.toThrow();
    await expect(db.prisma.teamArchiveOperation.delete({ where: { id: params.id } })).rejects.toThrow('immutable');
    expect((await previewEntityDeletion(db.prisma, 'ORGANISATION', org.id, 'RETAIN_REFERENCE')).blockers)
      .toContain('Permanent deletion of an archived team is on hold.');
    await expect(beginTeamArchive(params, { prisma: db.prisma })).resolves.toEqual(receipt);
    await expect(readTeamArchive(params.id, 'another-product', db.prisma)).rejects.toThrow();
    await reconcileTeamArchives({ prisma: db.prisma });
    expect(await readTeamArchive(params.id, client.id, db.prisma)).toMatchObject({ status: 'ARCHIVED', billing_stopped: true });
  });

  it('revokes every consuming product while leaving the sibling team usable', async () => {
    const { owner, org, team, sibling, params } = await seed({ sibling: true });
    for (const [product, target] of [[domain, team.id], ['another.example.com', team.id], [domain, sibling!.id]]) {
      await db.prisma.refreshToken.create({ data: { tokenHash: randomUUID(), familyId: randomUUID(), userId: owner.id,
        domain: product, clientId: randomUUID(), configUrl: `https://${product}/config`, orgId: org.id,
        teamId: target, expiresAt: new Date(Date.now() + 3600_000) } });
    }
    await beginTeamArchive(params, { prisma: db.prisma });
    const target = await db.prisma.refreshToken.findMany({ where: { teamId: team.id } });
    expect(target).toHaveLength(2); expect(target.every(token => token.revokedAt)).toBe(true);
    expect((await db.prisma.orgRevocationEvent.findMany({ where: { teamId: team.id } })).map(event => event.clientDomain).sort())
      .toEqual(['another.example.com', domain].sort());
    expect((await db.prisma.refreshToken.findFirstOrThrow({ where: { teamId: sibling!.id } })).revokedAt).toBeNull();
    await expect(assertEntityAccess({ userId: owner.id, teamId: sibling!.id }, db.prisma)).resolves.toBeUndefined();
  });

  it('refuses a member and a stale credential before changing lifecycle', async () => {
    const member = await seed({ role: 'member' });
    await expect(beginTeamArchive(member.params, { prisma: db.prisma })).rejects.toThrow();
    const stale = await seed(); stale.params.claims.tokenVersion += 1;
    await expect(beginTeamArchive(stale.params, { prisma: db.prisma })).rejects.toThrow();
    for (const id of [member.team.id, stale.team.id]) {
      expect((await db.prisma.team.findUniqueOrThrow({ where: { id } })).lifecycleStatus).toBe('ACTIVE');
      expect(await db.prisma.teamArchiveOperation.count({ where: { teamId: id } })).toBe(0);
    }
  });

  it('keeps ordinary tenant writes working without exposing archive evidence through RLS', async () => {
    const { owner, org, team, params } = await seed();
    const app = new PrismaClient({ datasources: { db: { url: db.appDatabaseUrl } } });
    try {
      await runWithTenantContext({ prisma: app, context: { domain, orgId: org.id, userId: owner.id, domainBackend: true } }, async tx => {
        await expect(tx.team.update({ where: { id: team.id }, data: { lifecycleStatus: 'ACTIVE' } })).resolves.toMatchObject({ id: team.id });
        expect(await tx.teamArchiveOperation.findMany()).toEqual([]);
      });
      await beginTeamArchive(params, { prisma: db.prisma });
      expect(await app.teamArchiveOperation.findMany()).toEqual([]);
      await expect(app.teamArchiveOperation.create({ data: { id: randomUUID(), orgId: org.id, teamId: team.id,
        actorUserId: owner.id, sourceClientDomainId: 'foreign', settleAfter: new Date() } })).rejects.toThrow();
    } finally { await app.$disconnect(); }
  });

  it('denies a provider create after archiving and retries failed billing without certifying success', async () => {
    const { params, client } = await seed();
    await beginTeamArchive(params, { prisma: db.prisma });
    const provider = vi.fn();
    await expect(withLiveTeamBillingEffect(db.prisma, { organisationId: params.orgId, teamId: params.teamId }, provider)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
    await reconcileTeamArchives({ prisma: db.prisma, stopBilling: vi.fn().mockRejectedValue(new Error('provider offline')) });
    expect(await readTeamArchive(params.id, client.id, db.prisma)).toMatchObject({ billing_stopped: false });
    await reconcileTeamArchives({ prisma: db.prisma, now: () => new Date(Date.now() + 60_000), stopBilling: vi.fn().mockResolvedValue(true) });
    expect(await readTeamArchive(params.id, client.id, db.prisma)).toMatchObject({ billing_stopped: true });
  });
});
