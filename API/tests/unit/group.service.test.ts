import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  addGroupMember,
  assignTeamToGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  removeGroupMember,
  updateGroup,
  updateGroupMemberAdmin,
} from '../../src/services/group.service.js';

function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
  return {
    org_features: {
      enabled: true,
      groups_enabled: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
      ...overrides,
    },
  } as unknown as ClientConfig;
}

function makePrismaMock() {
  const prisma = {
    organisation: {
      findFirst: vi.fn(),
    },
    orgMember: {
      findFirst: vi.fn(),
    },
    group: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    groupMember: {
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    team: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  } as unknown as PrismaClient;

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma));

  return prisma;
}

const now = new Date('2026-02-15T00:00:00.000Z');

describe('Group service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists groups for an organisation with cursor pagination', async () => {
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
    prisma.group.findMany.mockResolvedValue([
      {
        id: 'group-new',
        orgId: 'org-1',
        name: 'General',
        description: 'Team hub',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'group-old',
        orgId: 'org-1',
        name: 'Legacy',
        description: null,
        createdAt: new Date('2026-02-14T00:00:00.000Z'),
        updatedAt: new Date('2026-02-14T00:00:00.000Z'),
      },
    ]);

    const result = await listGroups(
      {
        orgId: 'org-1',
        domain: 'Acme.Example.com',
        limit: 1,
        cursor: 'cursor-group',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toEqual({
      data: [
        {
          id: 'group-new',
          orgId: 'org-1',
          name: 'General',
          description: 'Team hub',
          createdAt: now,
          updatedAt: now,
        },
      ],
      next_cursor: 'group-old',
    });
    expect(prisma.group.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1' },
        take: 2,
        cursor: { id: 'cursor-group' },
        skip: 1,
      }),
    );
  });

  it('creates a group when under the organisation group quota', async () => {
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
    prisma.group.count.mockResolvedValue(3);
    prisma.group.create.mockResolvedValue({
      id: 'group-1',
      orgId: 'org-1',
      name: 'Support',
      description: 'Support team',
      createdAt: now,
      updatedAt: now,
    });

    const result = await createGroup(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        name: 'Support',
        description: 'Support team',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({
      id: 'group-1',
      orgId: 'org-1',
      name: 'Support',
      description: 'Support team',
    });
  });

  it('rejects creating a group when max_groups_per_org is reached', async () => {
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
    prisma.group.count.mockResolvedValue(2);

    const promise = createGroup(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        name: 'Support',
        config: makeConfig({ max_groups_per_org: 2 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.group.create).not.toHaveBeenCalled();
  });

  it('reads a group and maps teams and members', async () => {
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
    prisma.group.findFirst.mockResolvedValue({
      id: 'group-1',
      orgId: 'org-1',
      name: 'Support',
      description: null,
      createdAt: now,
      updatedAt: now,
      teams: [
        {
          id: 'team-1',
          orgId: 'org-1',
          groupId: 'group-1',
          name: 'Tier 1',
          description: 'First line',
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      members: [
        {
          id: 'gm-1',
          groupId: 'group-1',
          userId: 'u-owner',
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const result = await getGroup(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({
      id: 'group-1',
      teams: [{ id: 'team-1' }],
      members: [{ userId: 'u-owner', isAdmin: true }],
    });
  });

  it('updates a group name and description', async () => {
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
    prisma.group.update.mockResolvedValue({
      id: 'group-1',
      orgId: 'org-1',
      name: 'Customer Success',
      description: 'Support groups',
      createdAt: now,
      updatedAt: now,
    });

    const result = await updateGroup(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        name: 'Customer Success',
        description: 'Support groups',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({
      name: 'Customer Success',
      description: 'Support groups',
    });
  });

  it('rejects updating a group without fields', async () => {
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

    const promise = updateGroup(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it('deletes a group when it exists', async () => {
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
    prisma.group.delete.mockResolvedValue({
      id: 'group-1',
      orgId: 'org-1',
      name: 'Support',
      description: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await deleteGroup(
      {
        orgId: 'org-1',
        groupId: 'group-1',
        domain: 'acme.example.com',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toEqual({ deleted: true });
  });

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

    const member = await updateGroupMemberAdmin({
      orgId: 'org-1',
      groupId: 'group-1',
      domain: 'acme.example.com',
      userId: 'u-owner',
      isAdmin: true,
      config: makeConfig(),
    });

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

    const result = await removeGroupMember({
      orgId: 'org-1',
      groupId: 'group-1',
      domain: 'acme.example.com',
      userId: 'u-owner',
      config: makeConfig(),
    });

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

  it('returns 404 when group features are disabled', async () => {
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

    const promise = createGroup(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        name: 'Support',
        config: makeConfig({ enabled: false, groups_enabled: false }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});
