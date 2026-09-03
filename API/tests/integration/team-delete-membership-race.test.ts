import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { removeTeamMember } from '../../src/services/team.service.members.js';
import { deleteTeam } from '../../src/services/team.service.teams.js';
import { lockTeamMembershipRows } from '../../src/services/team-scope.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'team-delete-race.example.com';

type SeededTeam = {
  ownerId: string;
  userId: string;
  orgId: string;
  defaultTeamId: string;
  targetTeamId: string;
  backupTeamId: string;
};

/**
 * The verified client config the team services now take: their capability gate resolves the
 * domain's `role_grants` out of it. No `org_features.role_grants` here, so the legacy default
 * table applies — the behaviour these race tests were written against.
 */
function teamConfig(): ClientConfig {
  return validateConfigFields(baseClientConfigPayload({ domain }));
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!hasDatabase)('team deletion and membership removal race', () => {
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
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  async function seedTeam(): Promise<SeededTeam> {
    const owner = await handle.prisma.user.create({
      data: { email: 'owner@team-delete-race.example.com', userKey: 'team-delete-owner' },
      select: { id: true },
    });
    const user = await handle.prisma.user.create({
      data: { email: 'member@team-delete-race.example.com', userKey: 'team-delete-member' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain,
        name: 'Team Delete Race Org',
        slug: `team-delete-race-${owner.id}`,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: user.id, role: 'member' },
      ],
    });
    const defaultTeam = await handle.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'General',
        slug: `general-${owner.id}`,
        isDefault: true,
      },
      select: { id: true },
    });
    const targetTeam = await handle.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Target',
        slug: `target-${owner.id}`,
      },
      select: { id: true },
    });
    const backupTeam = await handle.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Backup',
        slug: `backup-${owner.id}`,
      },
      select: { id: true },
    });
    await handle.prisma.teamMember.createMany({
      data: [
        { teamId: defaultTeam.id, userId: owner.id, teamRole: 'owner' },
        { teamId: targetTeam.id, userId: user.id, teamRole: 'member' },
        { teamId: backupTeam.id, userId: user.id, teamRole: 'member' },
      ],
    });
    return {
      ownerId: owner.id,
      userId: user.id,
      orgId: org.id,
      defaultTeamId: defaultTeam.id,
      targetTeamId: targetTeam.id,
      backupTeamId: backupTeam.id,
    };
  }

  async function seedMemberWithoutTeam(team: SeededTeam): Promise<string> {
    const user = await handle.prisma.user.create({
      data: {
        email: 'late-member@team-delete-race.example.com',
        userKey: 'team-delete-late-member',
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: {
        orgId: team.orgId,
        userId: user.id,
        role: 'member',
      },
    });
    return user.id;
  }

  function remove(
    team: SeededTeam,
    afterMembershipStatusWrite?: () => Promise<void>,
  ) {
    return removeTeamMember(
      {
        orgId: team.orgId,
        teamId: team.targetTeamId,
        domain,
        actorUserId: team.ownerId,
        userId: team.userId,
        config: teamConfig(),
      },
      {
        prisma: handle.prisma,
        afterMembershipStatusWrite,
      },
    );
  }

  function deleteTargetTeam(
    team: SeededTeam,
    afterMembershipLocks?: () => Promise<void>,
  ) {
    return deleteTeam(
      {
        orgId: team.orgId,
        teamId: team.targetTeamId,
        domain,
        actorUserId: team.ownerId,
        config: teamConfig(),
      },
      {
        prisma: handle.prisma,
        afterMembershipLocks,
      },
    );
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const state = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(state).toBe('pending');
  }

  async function expectOnlyBackupMembership(team: SeededTeam): Promise<void> {
    expect(
      await handle.prisma.teamMember.findUnique({
        where: {
          teamId_userId: {
            teamId: team.defaultTeamId,
            userId: team.userId,
          },
        },
        select: { status: true },
      }),
    ).toBeNull();
    expect(
      await handle.prisma.teamMember.findUniqueOrThrow({
        where: {
          teamId_userId: {
            teamId: team.backupTeamId,
            userId: team.userId,
          },
        },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACTIVE' });
    expect(
      await handle.prisma.teamMember.count({
        where: {
          userId: team.userId,
          team: { orgId: team.orgId },
          status: 'ACTIVE',
        },
      }),
    ).toBe(1);
  }

  it('does not recreate default membership when removal obtains the locks first', async () => {
    const team = await seedTeam();
    const statusWritten = deferred();
    const releaseRemoval = deferred();

    const removal = remove(team, async () => {
      statusWritten.resolve();
      await releaseRemoval.promise;
    });
    await statusWritten.promise;

    const deletion = deleteTargetTeam(team);
    await expectStillPending(deletion);
    releaseRemoval.resolve();

    await expect(removal).resolves.toEqual({ removed: true });
    await expect(deletion).resolves.toEqual({ deleted: true });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: team.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    await expectOnlyBackupMembership(team);
  });

  it('deletes first and makes a waiting removal fail against current state', async () => {
    const team = await seedTeam();
    const membershipsLocked = deferred();
    const releaseDeletion = deferred();

    const deletion = deleteTargetTeam(team, async () => {
      membershipsLocked.resolve();
      await releaseDeletion.promise;
    });
    await membershipsLocked.promise;

    const removal = remove(team);
    await expectStillPending(removal);
    releaseDeletion.resolve();

    await expect(deletion).resolves.toEqual({ deleted: true });
    await expect(removal).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: team.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    await expectOnlyBackupMembership(team);
  });

  it('waits for an in-flight insert, then re-homes its committed member', async () => {
    const team = await seedTeam();
    const lateUserId = await seedMemberWithoutTeam(team);
    const membershipInserted = deferred();
    const releaseInsertion = deferred();

    const insertion = handle.prisma.$transaction(async (tx) => {
      await lockTeamMembershipRows(
        { userId: lateUserId, orgId: team.orgId },
        { prisma: tx },
      );
      const membership = await tx.teamMember.create({
        data: {
          teamId: team.targetTeamId,
          userId: lateUserId,
          teamRole: 'member',
        },
        select: { id: true },
      });
      membershipInserted.resolve();
      await releaseInsertion.promise;
      return membership;
    });
    await membershipInserted.promise;

    const deletion = deleteTargetTeam(team);
    await expectStillPending(deletion);
    releaseInsertion.resolve();

    await expect(insertion).resolves.toEqual({ id: expect.any(String) });
    await expect(deletion).resolves.toEqual({ deleted: true });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: team.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await handle.prisma.teamMember.findUniqueOrThrow({
        where: {
          teamId_userId: {
            teamId: team.defaultTeamId,
            userId: lateUserId,
          },
        },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACTIVE' });
  });

  it('blocks a late insert behind deletion and leaves no orphan membership', async () => {
    const team = await seedTeam();
    const lateUserId = await seedMemberWithoutTeam(team);
    const targetTeamLocked = deferred();
    const releaseDeletion = deferred();

    const deletionWithLockHook = deleteTeam(
      {
        orgId: team.orgId,
        teamId: team.targetTeamId,
        domain,
        actorUserId: team.ownerId,
        config: teamConfig(),
      },
      {
        prisma: handle.prisma,
        afterTargetTeamLock: async () => {
          targetTeamLocked.resolve();
          await releaseDeletion.promise;
        },
      },
    );
    await targetTeamLocked.promise;

    const insertAttempted = deferred();
    const insertion = handle.prisma.$transaction(async (tx) => {
      await lockTeamMembershipRows(
        { userId: lateUserId, orgId: team.orgId },
        { prisma: tx },
      );
      insertAttempted.resolve();
      return tx.teamMember.create({
        data: {
          teamId: team.targetTeamId,
          userId: lateUserId,
          teamRole: 'member',
        },
        select: { id: true },
      });
    });
    await insertAttempted.promise;
    await expectStillPending(insertion);
    releaseDeletion.resolve();

    await expect(deletionWithLockHook).resolves.toEqual({ deleted: true });
    await expect(insertion).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: team.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await handle.prisma.teamMember.count({
        where: { userId: lateUserId },
      }),
    ).toBe(0);
  });
});
