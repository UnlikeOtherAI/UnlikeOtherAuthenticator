import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MembershipStatus } from '@prisma/client';

import { runInTransaction } from '../../src/db/tenant-context.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';

describe.skipIf(!hasDatabase)('personal invite ACTIVE membership invariant', () => {
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
    await handle.prisma.teamInvite.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  const config = validateConfigFields(
    baseClientConfigPayload({
      org_features: {
        enabled: true,
        max_members_per_org: 100,
        max_members_per_team: 100,
        max_team_memberships_per_user: 100,
      },
    }),
  );

  async function seed(params: {
    orgStatus: MembershipStatus;
    teamStatus: MembershipStatus;
    accepted?: boolean;
  }) {
    const owner = await handle.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com' },
      select: { id: true },
    });
    const user = await handle.prisma.user.create({
      data: { email: 'invitee@example.com', userKey: 'invitee@example.com' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain, name: 'Invite Org', slug: 'invite-org', ownerId: owner.id },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    await handle.prisma.orgMember.create({
      data: {
        orgId: org.id,
        userId: user.id,
        role: 'member',
        status: params.orgStatus,
      },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Invite Team', slug: 'invite-team' },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });
    await handle.prisma.teamMember.create({
      data: {
        teamId: team.id,
        userId: user.id,
        teamRole: 'member',
        status: params.teamStatus,
      },
    });
    const now = new Date();
    const invite = await handle.prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email: 'invitee@example.com',
        invitedByUserId: owner.id,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        acceptedAt: params.accepted ? now : null,
        acceptedUserId: params.accepted ? user.id : null,
      },
      select: { id: true },
    });
    return { userId: user.id, orgId: org.id, teamId: team.id, inviteId: invite.id };
  }

  async function accept(inviteId: string, userId: string) {
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

  it.each([
    ['DEACTIVATED org tombstone', 'DEACTIVATED', 'ACTIVE'],
    ['REMOVED team tombstone', 'ACTIVE', 'REMOVED'],
  ] as const)('fails closed for an unresolved invite with a %s', async (_name, orgStatus, teamStatus) => {
    const seeded = await seed({ orgStatus, teamStatus });

    await expect(accept(seeded.inviteId, seeded.userId)).rejects.toMatchObject({
      statusCode: 401,
    });
    const invite = await handle.prisma.teamInvite.findUniqueOrThrow({
      where: { id: seeded.inviteId },
      select: { acceptedAt: true, acceptedUserId: true },
    });
    expect(invite).toEqual({ acceptedAt: null, acceptedUserId: null });
    expect(
      await handle.prisma.orgMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: seeded.orgId, userId: seeded.userId } },
        select: { status: true },
      }),
    ).toEqual({ status: orgStatus });
    expect(
      await handle.prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId: seeded.teamId, userId: seeded.userId } },
        select: { status: true },
      }),
    ).toEqual({ status: teamStatus });
  });

  it.each(['DEACTIVATED', 'REMOVED'] as const)(
    'rejects already-accepted same-user replay when team membership is %s',
    async (teamStatus) => {
      const seeded = await seed({ orgStatus: 'ACTIVE', teamStatus, accepted: true });

      await expect(accept(seeded.inviteId, seeded.userId)).rejects.toMatchObject({
        statusCode: 401,
      });
    },
  );

  it('keeps already-accepted replay idempotent only for the exact ACTIVE scope', async () => {
    const seeded = await seed({ orgStatus: 'ACTIVE', teamStatus: 'ACTIVE', accepted: true });

    await expect(accept(seeded.inviteId, seeded.userId)).resolves.toEqual({
      orgId: seeded.orgId,
      teamId: seeded.teamId,
    });
  });
});
