import { describe, expect, it } from 'vitest';
import { addGroupMember, assignTeamToGroup, removeGroupMember, updateGroupMemberAdmin } from '../../src/services/group.service.js';
import { makeConfig, makePrismaMock, now, useGroupServiceEnv } from './helpers/group-service-fixtures.js';

describe('Group service membership', () => {
  useGroupServiceEnv();

  it('adds a group member when under the per-group membership limit', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({ id: 'member-owner', orgId: 'org-1', userId: 'u-owner', role: 'member' });
    prisma.group.findFirst.mockResolvedValue({ id: 'group-1' });
    prisma.groupMember.count.mockResolvedValue(2);
    prisma.groupMember.create.mockResolvedValue({
      id: 'gm-1',
      groupId: 'group-1',
      userId: 'u-owner',
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    });

    const member = await addGroupMember(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        userId: 'u-owner',
        isAdmin: true,
        config: makeConfig(),
      },
      { prisma },
    );

    expect(member).toMatchObject({
      groupId: 'group-1',
      userId: 'u-owner',
      isAdmin: true,
    });
  });

  it('rejects adding a group member when max_members_per_group is reached', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({ id: 'member-owner', orgId: 'org-1', userId: 'u-owner', role: 'member' });
    prisma.group.findFirst.mockResolvedValue({ id: 'group-1' });
    prisma.groupMember.count.mockResolvedValue(500);

    const promise = addGroupMember(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        userId: 'u-owner',
        config: makeConfig({ max_members_per_group: 500 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.groupMember.create).not.toHaveBeenCalled();
  });

  it('updates a group member admin flag', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.group.findFirst.mockResolvedValue({ id: 'group-1' });
    prisma.groupMember.findFirst.mockResolvedValue({ id: 'gm-1', groupId: 'group-1', userId: 'u-owner' });
    prisma.groupMember.update.mockResolvedValue({
      id: 'gm-1',
      groupId: 'group-1',
      userId: 'u-owner',
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    });

    const member = await updateGroupMemberAdmin(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        userId: 'u-owner',
        isAdmin: true,
        config: makeConfig(),
      },
      { prisma },
    );

    expect(member).toMatchObject({
      groupId: 'group-1',
      userId: 'u-owner',
      isAdmin: true,
    });
  });

  it('removes a group member', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.group.findFirst.mockResolvedValue({ id: 'group-1' });
    prisma.groupMember.findFirst.mockResolvedValue({ id: 'gm-1' });
    prisma.groupMember.delete.mockResolvedValue({
      id: 'gm-1',
      groupId: 'group-1',
      userId: 'u-owner',
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await removeGroupMember(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        userId: 'u-owner',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toEqual({ removed: true });
  });

  it('assigns and unassigns a team to a group', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst
      .mockResolvedValueOnce({ id: 'team-1' })
      .mockResolvedValueOnce({ id: 'team-1' });
    prisma.group.findFirst.mockResolvedValueOnce({ id: 'group-1' });
    prisma.team.update
      .mockResolvedValueOnce({
        id: 'team-1',
        orgId: 'org-1',
        groupId: 'group-1',
        name: 'Team Alpha',
        description: null,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        id: 'team-1',
        orgId: 'org-1',
        groupId: null,
        name: 'Team Alpha',
        description: null,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      });

    const assigned = await assignTeamToGroup(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        groupId: 'group-1',
        config: makeConfig(),
      },
      { prisma },
    );
    expect(assigned.groupId).toBe('group-1');

    const unassigned = await assignTeamToGroup(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        groupId: null,
        config: makeConfig(),
      },
      { prisma },
    );
    expect(unassigned.groupId).toBeNull();
  });
});
