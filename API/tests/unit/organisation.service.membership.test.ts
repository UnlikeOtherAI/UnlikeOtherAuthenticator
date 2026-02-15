import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  OrganisationService,
  OrganisationServiceError,
} from '../../src/services/organisation.service.js';

const { randomBytes } = vi.hoisted(() => ({
  randomBytes: vi.fn(),
}));

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
