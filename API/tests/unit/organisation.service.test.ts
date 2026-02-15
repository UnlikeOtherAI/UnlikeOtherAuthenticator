import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  OrganisationService,
  OrganisationServiceError,
} from '../../src/services/organisation.service.js';

const randomBytes = vi.fn();

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');

  return {
    ...actual,
    randomBytes,
  };
});

const now = new Date('2026-02-15T00:00:00.000Z');

function makePrismaMock() {
  const prisma = {
    organisation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    orgMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    team: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    teamMember: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    group: {
      findMany: vi.fn(),
    },
    groupMember: {
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  } as unknown as PrismaClient;

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma));

  return prisma;
}

function makeLimits() {
  return {
    maxTeamsPerOrg: 100,
    maxMembersPerOrg: 1_000,
    maxTeamMembershipsPerUser: 50,
  };
}

describe('OrganisationService', () => {
  beforeEach(() => {
    randomBytes.mockReset();
    randomBytes.mockReturnValue(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  });

  it('creates an organisation, owner membership, and default team', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-owner' });
    prisma.organisation.findUnique.mockResolvedValue(null);
    prisma.organisation.create.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme Inc',
      slug: 'acme-inc',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.create.mockResolvedValue({
      id: 'team-default',
      orgId: 'org-1',
      name: 'General',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.create.mockResolvedValue({
      id: 'member-owner',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.teamMember.create.mockResolvedValue({
      id: 'tm-owner',
      teamId: 'team-default',
      userId: 'u-owner',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });

    const org = await service.createOrganisation({
      domain: 'Acme.Example.com',
      name: 'Acme Inc',
      ownerUserId: 'u-owner',
      ownerRole: 'OWNER',
      allowedRoles: ['owner', 'admin', 'member'],
      limits: makeLimits(),
    });

    expect(org).toMatchObject({
      id: 'org-1',
      domain: 'acme.example.com',
      slug: 'acme-inc',
      ownerId: 'u-owner',
    });

    expect(prisma.organisation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          domain: 'acme.example.com',
          name: 'Acme Inc',
          slug: 'acme-inc',
          ownerId: 'u-owner',
        },
      }),
    );
    expect(prisma.orgMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          orgId: 'org-1',
          userId: 'u-owner',
          role: 'owner',
        },
      }),
    );
    expect(prisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          orgId: 'org-1',
          name: 'General',
          isDefault: true,
        },
      }),
    );
    expect(prisma.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          teamId: 'team-default',
          userId: 'u-owner',
          role: 'member',
        },
      }),
    );
  });

  it('rejects creating an org when owner already belongs to another org on the domain', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.orgMember.findFirst.mockResolvedValue({ id: 'existing-member' });

    const promise = service.createOrganisation({
      domain: 'acme.example.com',
      name: 'Second org',
      ownerUserId: 'u-owner',
      ownerRole: 'owner',
      allowedRoles: ['owner', 'admin', 'member'],
      limits: makeLimits(),
    });

    await expect(promise).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
      message: 'User already belongs to an organisation on this domain.',
    } satisfies Partial<OrganisationServiceError>);
    expect(prisma.organisation.create).not.toHaveBeenCalled();
  });

  it('regenerates slug with random suffix when the base slug collides', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Original',
      slug: 'original',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.organisation.findUnique
      .mockResolvedValueOnce({ id: 'other-org' })
      .mockResolvedValueOnce(null);
    prisma.organisation.update.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme-aaaa',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });

    const result = await service.updateOrganisation({
      orgId: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      callerUserId: 'u-owner',
    });

    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1' },
        data: {
          name: 'Acme',
          slug: 'acme-aaaa',
        },
      }),
    );
    expect(result.slug).toBe('acme-aaaa');
    expect(randomBytes).toHaveBeenCalledTimes(1);
  });

  it('transfers ownership to an existing organisation member', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findUnique.mockResolvedValue({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new-owner',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.organisation.update.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-new-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.update.mockResolvedValue({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });

    const result = await service.transferOwnership({
      orgId: 'org-1',
      domain: 'acme.example.com',
      newOwnerUserId: 'u-new-owner',
      callerUserId: 'u-owner',
      allowedRoles: ['owner', 'admin', 'member'],
    });

    expect(result).toEqual({
      id: 'org-1',
      ownerId: 'u-new-owner',
    });
    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1' },
        data: { ownerId: 'u-new-owner' },
      }),
    );
    expect(prisma.orgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member-new' },
        data: { role: 'owner' },
      }),
    );
  });

  it('reads an organisation from its domain and id', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });

    const org = await service.getOrganisation({
      orgId: 'org-1',
      domain: 'Acme.Example.com',
    });

    expect(prisma.organisation.findFirst).toHaveBeenCalledWith({
      where: { id: 'org-1', domain: 'acme.example.com' },
    });
    expect(org).toMatchObject({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
    });
  });

  it('deletes an organisation when called by the owner and removes memberships first', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.deleteMany.mockResolvedValue({ count: 2 } as never);
    prisma.organisation.delete.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });

    await service.deleteOrganisation({
      orgId: 'org-1',
      domain: 'acme.example.com',
      callerUserId: 'u-owner',
    });

    expect(prisma.orgMember.deleteMany).toHaveBeenCalledWith({ where: { orgId: 'org-1' } });
    expect(prisma.organisation.delete).toHaveBeenCalledWith({ where: { id: 'org-1' } });
  });

  it('forbids deleting an organisation when caller is not the owner', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });

    const promise = service.deleteOrganisation({
      orgId: 'org-1',
      domain: 'acme.example.com',
      callerUserId: 'u-not-owner',
    });

    await expect(promise).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 403,
      message: 'Only the owner can delete an organisation.',
    } satisfies Partial<OrganisationServiceError>);
    expect(prisma.organisation.delete).not.toHaveBeenCalled();
  });

  it('removes a member and cascades team and group memberships', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findUnique.mockImplementation((args: unknown) => {
      const where = (args as { where?: { orgId_userId?: { orgId?: string; userId?: string } } }).where;
      if (where?.orgId_userId?.userId === 'u-owner') {
        return Promise.resolve({
          id: 'member-owner',
          orgId: 'org-1',
          userId: 'u-owner',
          role: 'owner',
          createdAt: now,
          updatedAt: now,
        });
      }

      return Promise.resolve({
        id: 'member-member',
        orgId: 'org-1',
        userId: 'u-member',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      });
    });

    prisma.group.findMany.mockResolvedValue([
      { id: 'group-1' },
      { id: 'group-2' },
    ]);
    prisma.teamMember.deleteMany.mockResolvedValue({ count: 1 } as never);
    prisma.groupMember.deleteMany.mockResolvedValue({ count: 2 } as never);
    prisma.orgMember.delete.mockResolvedValue({
      id: 'member-member',
      orgId: 'org-1',
      userId: 'u-member',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });

    await service.removeMember({
      orgId: 'org-1',
      domain: 'acme.example.com',
      userId: 'u-member',
      callerUserId: 'u-owner',
    });

    expect(prisma.teamMember.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'u-member',
        team: { orgId: 'org-1' },
      },
    });
    expect(prisma.group.findMany).toHaveBeenCalledWith({ where: { orgId: 'org-1' }, select: { id: true } });
    expect(prisma.groupMember.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'u-member',
        groupId: { in: ['group-1', 'group-2'] },
      },
    });
    expect(prisma.orgMember.delete).toHaveBeenCalledWith({ where: { id: 'member-member' } });
  });

  it('prevents adding a user to an org when they already belong to another org on the same domain', async () => {
    const prisma = makePrismaMock();
    const service = new OrganisationService(prisma, makeLimits());

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.orgMember.findUnique
      .mockResolvedValueOnce({
        id: 'member-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      })
      .mockResolvedValueOnce(null);
    prisma.orgMember.findFirst.mockResolvedValue({ id: 'other-org-membership' });

    const promise = service.addMember({
      orgId: 'org-1',
      domain: 'acme.example.com',
      userId: 'u-member',
      role: 'member',
      callerUserId: 'u-owner',
      limits: makeLimits(),
    });

    await expect(promise).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
      message: 'User already belongs to another organisation on this domain.',
    } satisfies Partial<OrganisationServiceError>);
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });
});
