import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeam,
} from '../../src/services/team.service.js';

function makePrismaMock() {
  const prisma = {
    organisation: {
      findFirst: vi.fn(),
    },
    orgMember: {
      findFirst: vi.fn(),
    },
    team: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    teamMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  } as unknown as PrismaClient;

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(prisma),
  );

  return prisma;
}

function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
  return {
    org_features: {
      enabled: true,
      groups_enabled: false,
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

const now = new Date('2026-02-15T00:00:00.000Z');

describe('Team service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists teams for an organisation member', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findMany.mockResolvedValue([
      {
        id: 'team-new',
        orgId: 'org-1',
        groupId: null,
        name: 'New',
        description: null,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'team-old',
        orgId: 'org-1',
        groupId: null,
        name: 'Old',
        description: null,
        isDefault: true,
        createdAt: new Date('2026-02-14T00:00:00.000Z'),
        updatedAt: new Date('2026-02-14T00:00:00.000Z'),
      },
    ]);

    const result = await listTeams(
      {
        orgId: 'org-1',
        domain: 'Acme.Example.com',
        actorUserId: 'u-owner',
        limit: 1,
        cursor: 'cursor-team',
      },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [
        {
          id: 'team-new',
          orgId: 'org-1',
          groupId: null,
          name: 'New',
          description: null,
          isDefault: false,
        },
      ],
      next_cursor: 'team-old',
    });
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1' },
        take: 2,
        cursor: { id: 'cursor-team' },
        skip: 1,
      }),
    );
  });

  it('creates a team when the org is under the team quota', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.count.mockResolvedValue(1);
    prisma.team.create.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      description: 'Core',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const team = await createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Engineering',
        description: 'Core',
        config: makeConfig({ max_teams_per_org: 2 }),
      },
      { prisma },
    );

    expect(team).toMatchObject({
      id: 'team-1',
      orgId: 'org-1',
      name: 'Engineering',
      description: 'Core',
    });
  });

  it('rejects creating a team when org reaches max_teams_per_org', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.count.mockResolvedValue(2);

    const promise = createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Engineering',
        config: makeConfig({ max_teams_per_org: 2 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it('reads a team and maps members', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      members: [
        {
          id: 'tm-owner',
          teamId: 'team-1',
          userId: 'u-owner',
          teamRole: 'lead',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const result = await getTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    expect(result).toMatchObject({
      id: 'team-1',
      name: 'Engineering',
      members: [{ userId: 'u-owner', teamRole: 'lead' }],
    });
  });

  it('updates a team name and description', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.team.update.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Platform',
      description: 'Core infra',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await updateTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Platform',
        description: 'Core infra',
      },
      { prisma },
    );

    expect(result.name).toBe('Platform');
  });

  it('reassigns remaining users before deleting a team', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst
      .mockResolvedValueOnce({ id: 'team-1', isDefault: false })
      .mockResolvedValueOnce({ id: 'team-default' });
    prisma.teamMember.findMany.mockResolvedValue([{ userId: 'u-owner' }, { userId: 'u-2' }]);
    prisma.teamMember.count.mockImplementation(async (args: { where: { userId?: string } }) => {
      if (args.where.userId === 'u-owner') return 1;
      return 2;
    });
    prisma.teamMember.create.mockResolvedValue({
      id: 'tm-moved',
      teamId: 'team-default',
      userId: 'u-owner',
      teamRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.delete.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Platform',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await deleteTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    expect(result).toEqual({ deleted: true });
    expect(prisma.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          teamId: 'team-default',
          userId: 'u-owner',
        },
      }),
    );
    expect(prisma.team.delete).toHaveBeenCalledWith({ where: { id: 'team-1' } });
  });

  it('rejects deleting the default team', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-default',
      isDefault: true,
    });

    const promise = deleteTeam(
      {
        orgId: 'org-1',
        teamId: 'team-default',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });

  it('prevents adding a user when the team is full', async () => {
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
    prisma.orgMember.findFirst.mockImplementation((args: { where: { userId: string } }) => {
      const userId = args.where.userId;
      return Promise.resolve({
        id: `m-${userId}`,
        orgId: 'org-1',
        userId,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      });
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.count.mockResolvedValue(10);

    const promise = addTeamMember(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-target',
        config: makeConfig({ max_members_per_team: 10 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('prevents a user from exceeding max_team_memberships_per_user', async () => {
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
    prisma.orgMember.findFirst.mockImplementation((args: { where: { userId: string } }) => {
      const userId = args.where.userId;
      return Promise.resolve({
        id: `m-${userId}`,
        orgId: 'org-1',
        userId,
        role: userId === 'u-owner' ? 'owner' : 'member',
        createdAt: now,
        updatedAt: now,
      });
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(5);

    const promise = addTeamMember(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-target',
        config: makeConfig({ max_members_per_team: 50, max_team_memberships_per_user: 5 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('prevents removing a user from their final team membership', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'tm-target',
      teamId: 'team-1',
      userId: 'u-target',
      teamRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.teamMember.count.mockResolvedValue(1);

    const promise = removeTeamMember(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-target',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });
});
