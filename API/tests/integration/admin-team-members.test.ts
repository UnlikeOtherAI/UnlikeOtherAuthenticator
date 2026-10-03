import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { addAdminUserToTeam } from '../../src/services/internal-admin-team-members.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { getAdminAuthDomain } from '../../src/config/env.js';

const actor = {
  via: 'admin_superuser' as const,
  userId: 'operator',
  email: 'operator@example.com',
  tokenVersion: 0,
};

describe.skipIf(!process.env.DATABASE_URL)('Admin Add User to Team persistence', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async () => {
    db = (await createTestDb())!;
    await db.prisma.user.create({
      data: { id: actor.userId, email: actor.email, userKey: actor.userId },
    });
    await db.prisma.domainRole.create({
      data: { userId: actor.userId, domain: getAdminAuthDomain(), role: 'SUPERUSER' },
    });
  });
  afterAll(async () => {
    await db?.cleanup();
  });

  async function seed() {
    const suffix = randomUUID();
    const owner = await db.prisma.user.create({
      data: { email: `owner-${suffix}@example.com`, userKey: `owner-${suffix}` },
    });
    const user = await db.prisma.user.create({
      data: { email: `user-${suffix}@example.com`, userKey: `user-${suffix}` },
    });
    const org = await db.prisma.organisation.create({
      data: {
        name: 'Family',
        slug: `org-${suffix}`,
        domain: 'example.com/product',
        ownerId: owner.id,
      },
    });
    const defaultTeam = await db.prisma.team.create({
      data: { orgId: org.id, name: 'Family', slug: 'family', isDefault: true },
    });
    const team = await db.prisma.team.create({
      data: { orgId: org.id, name: 'Media', slug: 'media' },
    });
    const input = {
      userId: user.id,
      orgId: org.id,
      teamId: team.id,
      teamRole: 'admin' as const,
      actor,
    };
    return { input, user, org, team, defaultTeam };
  }
  const add = (input: Parameters<typeof addAdminUserToTeam>[0]) =>
    addAdminUserToTeam(input, { prisma: db.prisma });

  it('refuses disabled identities and containers without adding membership', async () => {
    for (const scope of ['user', 'organisation', 'team', 'defaultTeam'] as const) {
      const { input, defaultTeam } = await seed();
      if (scope === 'user')
        await db.prisma.user.update({
          where: { id: input.userId },
          data: { lifecycleStatus: 'DISABLED' },
        });
      else if (scope === 'organisation')
        await db.prisma.organisation.update({
          where: { id: input.orgId },
          data: { lifecycleStatus: 'DISABLED' },
        });
      else
        await db.prisma.team.update({
          where: { id: scope === 'team' ? input.teamId : defaultTeam.id },
          data: { lifecycleStatus: 'DISABLED' },
        });
      await expect(add(input)).rejects.toMatchObject({ statusCode: 403 });
      expect(await db.prisma.orgMember.count({ where: { userId: input.userId } })).toBe(0);
      expect(await db.prisma.teamMember.count({ where: { userId: input.userId } })).toBe(0);
    }
  });

  it('rechecks the administrator credential epoch at the write boundary', async () => {
    const { input } = await seed();
    await expect(add({ ...input, actor: { ...actor, tokenVersion: 1 } })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await db.prisma.orgMember.count({ where: { userId: input.userId } })).toBe(0);
  });

  it('persists org, default and selected membership, and one atomic audit trail across concurrent retries', async () => {
    const { input, defaultTeam } = await seed();
    const results = await Promise.all([add(input), add(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await db.prisma.orgMember.findMany({
        where: { userId: input.userId },
        select: { role: true, status: true },
      }),
    ).toEqual([{ role: 'member', status: 'ACTIVE' }]);
    expect(
      await db.prisma.teamMember.findMany({
        where: { userId: input.userId },
        orderBy: { teamRole: 'asc' },
        select: { teamId: true, teamRole: true },
      }),
    ).toEqual([
      { teamId: input.teamId, teamRole: 'admin' },
      { teamId: defaultTeam.id, teamRole: 'member' },
    ]);
    expect(await db.prisma.orgAuditLog.count({ where: { orgId: input.orgId } })).toBe(3);
    expect(
      await db.prisma.adminAuditLog.count({
        where: { metadata: { path: ['userId'], equals: input.userId } },
      }),
    ).toBe(1);
  });

  it('adds a default team only once and retains existing organisation privileges', async () => {
    const { input, defaultTeam } = await seed();
    await db.prisma.orgMember.create({
      data: { orgId: input.orgId, userId: input.userId, role: 'admin' },
    });
    await add({ ...input, teamId: defaultTeam.id });
    expect(await db.prisma.teamMember.count({ where: { userId: input.userId } })).toBe(1);
    expect(
      await db.prisma.orgMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
      }),
    ).toMatchObject({ role: 'admin' });
    await expect(
      add({ ...input, teamId: defaultTeam.id, teamRole: 'member' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('re-adds removed memberships with fresh roles, leaving unrelated removed teams alone', async () => {
    const { input, defaultTeam } = await seed();
    await db.prisma.orgMember.create({
      data: { orgId: input.orgId, userId: input.userId, role: 'admin', status: 'REMOVED' },
    });
    await db.prisma.teamMember.create({
      data: { teamId: defaultTeam.id, userId: input.userId, teamRole: 'admin', status: 'REMOVED' },
    });
    await add(input);
    expect(
      await db.prisma.orgMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
      }),
    ).toMatchObject({ role: 'member', status: 'ACTIVE' });
    expect(
      await db.prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId: defaultTeam.id, userId: input.userId } },
      }),
    ).toMatchObject({ teamRole: 'member', status: 'ACTIVE' });
  });

  it('refuses suspended memberships, wrong org/team pairs, domain-scoped identities and ownership', async () => {
    const { input } = await seed();
    const other = await seed();
    await expect(add({ ...input, teamId: other.team.id })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(add({ ...input, teamRole: 'owner' as 'member' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await db.prisma.user.update({
      where: { id: input.userId },
      data: { domain: 'other.example.com' },
    });
    await expect(add(input)).rejects.toMatchObject({ statusCode: 400 });
    await db.prisma.user.update({ where: { id: input.userId }, data: { domain: null } });
    await db.prisma.orgMember.create({
      data: { orgId: input.orgId, userId: input.userId, status: 'DEACTIVATED' },
    });
    await expect(add(input)).rejects.toMatchObject({ message: 'MEMBERSHIP_DEACTIVATED' });
    expect(await db.prisma.teamMember.count({ where: { userId: input.userId } })).toBe(0);
    expect(await db.prisma.orgAuditLog.count({ where: { orgId: input.orgId } })).toBe(0);
  });

  it('rolls back all membership writes when the audit cannot commit', async () => {
    const { input } = await seed();
    await expect(
      db.prisma.$transaction(async (tx) => {
        const failedAudit = {
          create: async () => {
            throw new Error('audit unavailable');
          },
        };
        return addAdminUserToTeam(input, {
          prisma: { ...tx, adminAuditLog: failedAudit } as unknown as typeof db.prisma,
        });
      }),
    ).rejects.toThrow('audit unavailable');
    expect(await db.prisma.orgMember.count({ where: { userId: input.userId } })).toBe(0);
    expect(await db.prisma.teamMember.count({ where: { userId: input.userId } })).toBe(0);
    expect(await db.prisma.orgAuditLog.count({ where: { orgId: input.orgId } })).toBe(0);
  });

  it('refuses a full target team before adding the organisation or default team', async () => {
    const { input } = await seed();
    const ids = Array.from({ length: 200 }, () => randomUUID());
    await db.prisma.user.createMany({
      data: ids.map((id) => ({ id, email: `${id}@example.com`, userKey: id })),
    });
    await db.prisma.teamMember.createMany({
      data: ids.map((userId) => ({ teamId: input.teamId, userId })),
    });
    await expect(add(input)).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.prisma.orgMember.count({ where: { userId: input.userId } })).toBe(0);
    expect(await db.prisma.teamMember.count({ where: { userId: input.userId } })).toBe(0);
  });
});
