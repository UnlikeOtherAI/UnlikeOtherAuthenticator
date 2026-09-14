import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runInTransaction } from '../../src/db/tenant-context.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { deactivateOrganisationMember } from '../../src/services/organisation.service.lifecycle.js';
import { removeOrganisationMember } from '../../src/services/organisation.service.members.js';
import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';

type OrgLifecyclePrisma = NonNullable<
  NonNullable<Parameters<typeof removeOrganisationMember>[1]>['prisma']
>;

/**
 * Production 2026-09-14: a member removed from an organisation could never be re-invited. Removal
 * tombstones the org and team rows as REMOVED, and acceptance refused every non-ACTIVE row, so a
 * fresh valid invitation failed and the only way back was hard-deleting the membership rows.
 *
 * These run the real removal/deactivation services rather than seeding statuses, so the
 * tombstones are exactly what production writes (including a removed admin keeping role=admin).
 */
describe.skipIf(!hasDatabase)('re-inviting a removed organisation member', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle.prisma.orgAuditLog.deleteMany();
    await handle.prisma.teamInvite.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  function makeConfig(limits?: {
    max_members_per_org?: number;
    max_members_per_team?: number;
    max_team_memberships_per_user?: number;
  }): ClientConfig {
    return validateConfigFields(
      baseClientConfigPayload({
        domain,
        org_features: {
          enabled: true,
          org_roles: ['owner', 'admin', 'member'],
          max_members_per_org: 100,
          max_members_per_team: 100,
          max_team_memberships_per_user: 100,
          ...limits,
        },
      }),
    );
  }

  async function createUser(email: string) {
    return await handle.prisma.user.create({
      data: { email, userKey: email },
      select: { id: true },
    });
  }

  /** An org whose owner is ACTIVE and whose invitee is an ACTIVE admin of the default team. */
  async function seedOrgWithAdminMember() {
    const owner = await createUser('owner@example.com');
    const invitee = await createUser('invitee@example.com');
    const org = await handle.prisma.organisation.create({
      data: { domain, name: 'Reinvite Org', slug: 'reinvite-org', ownerId: owner.id },
      select: { id: true },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Reinvite Org', slug: 'reinvite-org-team', isDefault: true },
      select: { id: true },
    });
    const otherTeam = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Other Team', slug: 'other-team' },
      select: { id: true },
    });
    await handle.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: invitee.id, role: 'admin' },
      ],
    });
    await handle.prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: owner.id, teamRole: 'owner' },
        { teamId: team.id, userId: invitee.id, teamRole: 'admin' },
        { teamId: otherTeam.id, userId: invitee.id, teamRole: 'admin' },
      ],
    });
    return {
      ownerId: owner.id,
      userId: invitee.id,
      orgId: org.id,
      teamId: team.id,
      otherTeamId: otherTeam.id,
    };
  }

  async function removeMember(seeded: { ownerId: string; userId: string; orgId: string }) {
    await removeOrganisationMember(
      {
        orgId: seeded.orgId,
        domain,
        actorUserId: seeded.ownerId,
        userId: seeded.userId,
        config: makeConfig(),
      },
      { prisma: handle.prisma as unknown as OrgLifecyclePrisma },
    );
  }

  async function invite(params: { orgId: string; teamId: string; ownerId: string; teamRole?: string }) {
    const now = new Date();
    return await handle.prisma.teamInvite.create({
      data: {
        orgId: params.orgId,
        teamId: params.teamId,
        email: 'invitee@example.com',
        teamRole: params.teamRole ?? 'member',
        invitedByUserId: params.ownerId,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
      },
      select: { id: true },
    });
  }

  async function accept(inviteId: string, userId: string, config = makeConfig()) {
    return await runInTransaction(handle.prisma, (tx) =>
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: inviteId,
        userId,
        config,
        now: new Date(),
      }),
    );
  }

  async function membership(seeded: { orgId: string; userId: string }, teamId: string) {
    const [org, team] = await Promise.all([
      handle.prisma.orgMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: seeded.orgId, userId: seeded.userId } },
        select: { role: true, status: true, statusChangedAt: true },
      }),
      handle.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: seeded.userId } },
        select: { teamRole: true, status: true },
      }),
    ]);
    return { org, team };
  }

  it('reactivates a removed admin as a plain member with the invited team role', async () => {
    const seeded = await seedOrgWithAdminMember();
    await removeMember(seeded);
    const removed = await membership(seeded, seeded.teamId);
    expect(removed.org).toMatchObject({ role: 'admin', status: 'REMOVED' });
    expect(removed.team).toMatchObject({ status: 'REMOVED' });

    const { id: inviteId } = await invite({ ...seeded, teamRole: 'member' });
    await expect(accept(inviteId, seeded.userId)).resolves.toEqual({
      orgId: seeded.orgId,
      teamId: seeded.teamId,
    });

    const after = await membership(seeded, seeded.teamId);
    expect(after.org).toMatchObject({ role: 'member', status: 'ACTIVE' });
    expect(after.org.statusChangedAt!.getTime()).toBeGreaterThan(
      removed.org.statusChangedAt!.getTime(),
    );
    expect(after.team).toEqual({ teamRole: 'member', status: 'ACTIVE' });
    // Only the invited team comes back; the other team removed with the member stays tombstoned.
    expect((await membership(seeded, seeded.otherTeamId)).team).toMatchObject({
      status: 'REMOVED',
    });
    // Reactivated in place, never duplicated.
    expect(
      await handle.prisma.orgMember.count({ where: { orgId: seeded.orgId, userId: seeded.userId } }),
    ).toBe(1);
    expect(
      await handle.prisma.teamInvite.findUniqueOrThrow({
        where: { id: inviteId },
        select: { acceptedUserId: true },
      }),
    ).toEqual({ acceptedUserId: seeded.userId });

    const audit = await handle.prisma.orgAuditLog.findMany({
      where: { orgId: seeded.orgId, action: { in: ['member.reactivated', 'team_member.added'] } },
      select: { action: true, actorUserId: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit).toEqual([
      {
        action: 'member.reactivated',
        actorUserId: seeded.userId,
        metadata: expect.objectContaining({
          role: 'member',
          previousRole: 'admin',
          previousStatus: 'REMOVED',
          via: 'invite',
          inviteId,
        }),
      },
      {
        action: 'team_member.added',
        actorUserId: seeded.userId,
        metadata: expect.objectContaining({
          teamId: seeded.teamId,
          teamRole: 'member',
          reactivated: true,
          via: 'invite',
          inviteId,
        }),
      },
    ]);
  });

  it('reactivates the org row and creates the membership for a team the member never had', async () => {
    const seeded = await seedOrgWithAdminMember();
    const newTeam = await handle.prisma.team.create({
      data: { orgId: seeded.orgId, name: 'New Team', slug: 'new-team' },
      select: { id: true },
    });
    await removeMember(seeded);

    const { id: inviteId } = await invite({ ...seeded, teamId: newTeam.id, teamRole: 'admin' });
    await accept(inviteId, seeded.userId);

    const after = await membership(seeded, newTeam.id);
    expect(after.org).toMatchObject({ role: 'member', status: 'ACTIVE' });
    expect(after.team).toEqual({ teamRole: 'admin', status: 'ACTIVE' });
    expect((await membership(seeded, seeded.teamId)).team).toMatchObject({ status: 'REMOVED' });
  });

  it('keeps refusing a DEACTIVATED member with a named code and changes nothing', async () => {
    const seeded = await seedOrgWithAdminMember();
    await handle.prisma.orgMember.updateMany({
      where: { orgId: seeded.orgId, userId: seeded.userId },
      data: { role: 'member' },
    });
    await deactivateOrganisationMember(
      {
        orgId: seeded.orgId,
        domain,
        actorUserId: seeded.ownerId,
        userId: seeded.userId,
        config: makeConfig(),
      },
      { prisma: handle.prisma as unknown as OrgLifecyclePrisma },
    );

    const { id: inviteId } = await invite(seeded);
    await expect(accept(inviteId, seeded.userId)).rejects.toMatchObject({
      statusCode: 400,
      message: 'MEMBERSHIP_DEACTIVATED',
    });

    const after = await membership(seeded, seeded.teamId);
    expect(after.org.status).toBe('DEACTIVATED');
    expect(after.team?.status).toBe('DEACTIVATED');
    expect(
      await handle.prisma.teamInvite.findUniqueOrThrow({
        where: { id: inviteId },
        select: { acceptedAt: true },
      }),
    ).toEqual({ acceptedAt: null });
  });

  it('still accepts for an ACTIVE member without touching their existing roles', async () => {
    const seeded = await seedOrgWithAdminMember();

    const { id: inviteId } = await invite({ ...seeded, teamRole: 'member' });
    await expect(accept(inviteId, seeded.userId)).resolves.toEqual({
      orgId: seeded.orgId,
      teamId: seeded.teamId,
    });

    const after = await membership(seeded, seeded.teamId);
    expect(after.org).toMatchObject({ role: 'admin', status: 'ACTIVE' });
    expect(after.team).toEqual({ teamRole: 'admin', status: 'ACTIVE' });
    expect(await handle.prisma.orgAuditLog.count({ where: { orgId: seeded.orgId } })).toBe(0);
  });

  it('counts a reactivation against the organisation member limit like a new member', async () => {
    const seeded = await seedOrgWithAdminMember();
    await removeMember(seeded);
    const { id: inviteId } = await invite(seeded);

    // Owner is the only ACTIVE member: the removed tombstone does not hold a seat...
    await expect(
      accept(inviteId, seeded.userId, makeConfig({ max_members_per_org: 1 })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await membership(seeded, seeded.teamId)).org.status).toBe('REMOVED');

    // ...and with room for exactly one more ACTIVE member, the reactivation takes it.
    await expect(
      accept(inviteId, seeded.userId, makeConfig({ max_members_per_org: 2 })),
    ).resolves.toMatchObject({ orgId: seeded.orgId });
    expect((await membership(seeded, seeded.teamId)).org.status).toBe('ACTIVE');
  });

  it('counts a reactivation against the team and per-user membership limits', async () => {
    const seeded = await seedOrgWithAdminMember();
    await removeMember(seeded);
    const { id: inviteId } = await invite(seeded);

    // The default team already holds its one ACTIVE member (the owner).
    await expect(
      accept(inviteId, seeded.userId, makeConfig({ max_members_per_team: 1 })),
    ).rejects.toMatchObject({ statusCode: 400 });

    // The member already holds an ACTIVE membership in another team of this org.
    await handle.prisma.teamMember.update({
      where: { teamId_userId: { teamId: seeded.otherTeamId, userId: seeded.userId } },
      data: { status: 'ACTIVE' },
    });
    await expect(
      accept(inviteId, seeded.userId, makeConfig({ max_team_memberships_per_user: 1 })),
    ).rejects.toMatchObject({ statusCode: 400 });

    const after = await membership(seeded, seeded.teamId);
    expect(after.org.status).toBe('REMOVED');
    expect(after.team?.status).toBe('REMOVED');
    expect(
      await handle.prisma.orgAuditLog.count({ where: { action: 'member.reactivated' } }),
    ).toBe(0);
  });
});
