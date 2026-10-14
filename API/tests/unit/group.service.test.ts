import { describe, expect, it } from 'vitest';
import { createGroup, deleteGroup, getGroup, listGroups, updateGroup } from '../../src/services/group.service.js';
import { makeConfig, makePrismaMock, now, useGroupServiceEnv } from './helpers/group-service-fixtures.js';

describe('Group service CRUD', () => {
  useGroupServiceEnv();

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
      // Cursor is the last row of the returned page (brief §24.11 last_id).
      next_cursor: 'group-new',
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
