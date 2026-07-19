import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { removeTeamMember } from '../../src/services/team.service.members.js';
import { deleteTeam } from '../../src/services/team.service.teams.js';
import { lockWorkspaceMembershipRows } from '../../src/services/workspace-scope.service.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'team-delete-race.example.com';

type SeededWorkspace = {
  ownerId: string;
  userId: string;
  orgId: string;
  defaultTeamId: string;
  targetTeamId: string;
  backupTeamId: string;
};

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

  async function seedWorkspace(): Promise<SeededWorkspace> {
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

  async function seedMemberWithoutTeam(workspace: SeededWorkspace): Promise<string> {
    const user = await handle.prisma.user.create({
      data: {
        email: 'late-member@team-delete-race.example.com',
        userKey: 'team-delete-late-member',
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: {
        orgId: workspace.orgId,
        userId: user.id,
        role: 'member',
      },
    });
    return user.id;
  }

  function remove(
    workspace: SeededWorkspace,
    afterMembershipStatusWrite?: () => Promise<void>,
  ) {
    return removeTeamMember(
      {
        orgId: workspace.orgId,
        teamId: workspace.targetTeamId,
        domain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      {
        prisma: handle.prisma,
        afterMembershipStatusWrite,
      },
    );
  }

  function deleteTargetTeam(
    workspace: SeededWorkspace,
    afterMembershipLocks?: () => Promise<void>,
  ) {
    return deleteTeam(
      {
        orgId: workspace.orgId,
        teamId: workspace.targetTeamId,
        domain,
        actorUserId: workspace.ownerId,
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

  async function expectOnlyBackupMembership(workspace: SeededWorkspace): Promise<void> {
    expect(
      await handle.prisma.teamMember.findUnique({
        where: {
          teamId_userId: {
            teamId: workspace.defaultTeamId,
            userId: workspace.userId,
          },
        },
        select: { status: true },
      }),
    ).toBeNull();
    expect(
      await handle.prisma.teamMember.findUniqueOrThrow({
        where: {
          teamId_userId: {
            teamId: workspace.backupTeamId,
            userId: workspace.userId,
          },
        },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACTIVE' });
    expect(
      await handle.prisma.teamMember.count({
        where: {
          userId: workspace.userId,
          team: { orgId: workspace.orgId },
          status: 'ACTIVE',
        },
      }),
    ).toBe(1);
  }

  it('does not recreate default membership when removal obtains the locks first', async () => {
    const workspace = await seedWorkspace();
    const statusWritten = deferred();
    const releaseRemoval = deferred();

    const removal = remove(workspace, async () => {
      statusWritten.resolve();
      await releaseRemoval.promise;
    });
    await statusWritten.promise;

    const deletion = deleteTargetTeam(workspace);
    await expectStillPending(deletion);
    releaseRemoval.resolve();

    await expect(removal).resolves.toEqual({ removed: true });
    await expect(deletion).resolves.toEqual({ deleted: true });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: workspace.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    await expectOnlyBackupMembership(workspace);
  });

  it('deletes first and makes a waiting removal fail against current state', async () => {
    const workspace = await seedWorkspace();
    const membershipsLocked = deferred();
    const releaseDeletion = deferred();

    const deletion = deleteTargetTeam(workspace, async () => {
      membershipsLocked.resolve();
      await releaseDeletion.promise;
    });
    await membershipsLocked.promise;

    const removal = remove(workspace);
    await expectStillPending(removal);
    releaseDeletion.resolve();

    await expect(deletion).resolves.toEqual({ deleted: true });
    await expect(removal).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: workspace.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    await expectOnlyBackupMembership(workspace);
  });

  it('waits for an in-flight insert, then re-homes its committed member', async () => {
    const workspace = await seedWorkspace();
    const lateUserId = await seedMemberWithoutTeam(workspace);
    const membershipInserted = deferred();
    const releaseInsertion = deferred();

    const insertion = handle.prisma.$transaction(async (tx) => {
      await lockWorkspaceMembershipRows(
        { userId: lateUserId, orgId: workspace.orgId },
        { prisma: tx },
      );
      const membership = await tx.teamMember.create({
        data: {
          teamId: workspace.targetTeamId,
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

    const deletion = deleteTargetTeam(workspace);
    await expectStillPending(deletion);
    releaseInsertion.resolve();

    await expect(insertion).resolves.toEqual({ id: expect.any(String) });
    await expect(deletion).resolves.toEqual({ deleted: true });
    expect(
      await handle.prisma.team.findUnique({
        where: { id: workspace.targetTeamId },
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await handle.prisma.teamMember.findUniqueOrThrow({
        where: {
          teamId_userId: {
            teamId: workspace.defaultTeamId,
            userId: lateUserId,
          },
        },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACTIVE' });
  });

  it('blocks a late insert behind deletion and leaves no orphan membership', async () => {
    const workspace = await seedWorkspace();
    const lateUserId = await seedMemberWithoutTeam(workspace);
    const targetTeamLocked = deferred();
    const releaseDeletion = deferred();

    const deletionWithLockHook = deleteTeam(
      {
        orgId: workspace.orgId,
        teamId: workspace.targetTeamId,
        domain,
        actorUserId: workspace.ownerId,
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
      await lockWorkspaceMembershipRows(
        { userId: lateUserId, orgId: workspace.orgId },
        { prisma: tx },
      );
      insertAttempted.resolve();
      return tx.teamMember.create({
        data: {
          teamId: workspace.targetTeamId,
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
        where: { id: workspace.targetTeamId },
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
