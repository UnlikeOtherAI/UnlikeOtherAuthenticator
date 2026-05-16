import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  addOrganisationMember,
  changeOrganisationMemberRole,
  listOrganisationMembers,
  removeOrganisationMember,
  transferOrganisationOwnership,
} from '../../src/services/organisation.service.members.js';

const now = new Date('2026-02-15T00:00:00.000Z');

function makePrismaMock() {
  const prisma = {
    organisation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
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

function makeConfig(overrides?: Partial<NonNullable<ClientConfig['org_features']>>): ClientConfig {
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

const originalNodeEnv = process.env.NODE_ENV;
const originalSharedSecret = process.env.SHARED_SECRET;
const originalAuthServiceIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
const originalDatabaseUrl = process.env.DATABASE_URL;

const baseOrg = {
  id: 'org-1',
  domain: 'acme.example.com',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'u-owner',
  createdAt: now,
  updatedAt: now,
};

describe('Organisation service: membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAuthServiceIdentifier;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('lists organisation members with cursor pagination', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findMany.mockResolvedValue([
      {
        id: 'member-new',
        orgId: 'org-1',
        userId: 'u-new',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'member-old',
        orgId: 'org-1',
        userId: 'u-old',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await listOrganisationMembers(
      { orgId: 'org-1', domain: 'acme.example.com', limit: 1 },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'member-new', userId: 'u-new' }],
      next_cursor: 'member-old',
    });
  });

  it('adds a new organisation member and assigns the default team', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // First call: actor membership lookup (owner).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-new', domain: null });
    prisma.orgMember.create.mockResolvedValue({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-default' });
    prisma.teamMember.create.mockResolvedValue({ id: 'tm-new' });

    const member = await addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-new',
        role: 'member',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(member).toMatchObject({ id: 'member-new', userId: 'u-new', role: 'member' });
    expect(prisma.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { teamId: 'team-default', userId: 'u-new' } }),
    );
  });

  it('rejects adding a member when the actor is not owner or admin', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValueOnce({
      id: 'm-actor',
      orgId: 'org-1',
      userId: 'u-actor',
      role: 'member',
    });

    const promise = addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-actor',
        userId: 'u-new',
        role: 'member',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
  });

  it('changes a member role when called by the owner', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'member-target',
      orgId: 'org-1',
      userId: 'u-member',
      role: 'member',
    });
    prisma.orgMember.update.mockResolvedValue({
      id: 'member-target',
      orgId: 'org-1',
      userId: 'u-member',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const result = await changeOrganisationMemberRole(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
        role: 'admin',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({ id: 'member-target', role: 'admin' });
  });

  it('removes a member and cascades team and group memberships', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // actor lookup (owner), then target lookup (member).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      })
      .mockResolvedValueOnce({
        id: 'member-target',
        orgId: 'org-1',
        userId: 'u-member',
        role: 'member',
      });
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.orgMember.delete.mockResolvedValue({ id: 'member-target' });
    prisma.teamMember.deleteMany.mockResolvedValue({ count: 1 });
    prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });

    await removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
      },
      { prisma },
    );

    expect(prisma.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-member', team: { orgId: 'org-1' } },
    });
    expect(prisma.groupMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-member', group: { orgId: 'org-1' } },
    });
    expect(prisma.orgMember.delete).toHaveBeenCalledWith({ where: { id: 'member-target' } });
  });

  it('prevents removing the sole organisation owner', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      })
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      });
    prisma.orgMember.count.mockResolvedValue(1);

    const promise = removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.orgMember.delete).not.toHaveBeenCalled();
  });

  it('transfers ownership to an existing organisation member', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'member-new',
        orgId: 'org-1',
        userId: 'u-new-owner',
        role: 'member',
      })
      .mockResolvedValueOnce({
        id: 'member-old-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      });
    prisma.organisation.update.mockResolvedValue({
      ...baseOrg,
      ownerId: 'u-new-owner',
    });
    prisma.orgMember.update.mockResolvedValue({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.organisation.findUniqueOrThrow.mockResolvedValue({
      ...baseOrg,
      ownerId: 'u-new-owner',
    });

    const result = await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
      },
      { prisma },
    );

    expect(result).toMatchObject({ id: 'org-1', ownerId: 'u-new-owner' });
    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1' },
        data: { ownerId: 'u-new-owner' },
      }),
    );
  });

  it('refuses an admin actor from adding a new owner member (no self-elevation)', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValueOnce({
      id: 'm-actor',
      orgId: 'org-1',
      userId: 'u-admin',
      role: 'admin',
    });

    const promise = addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-admin',
        userId: 'u-new',
        role: 'owner',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
  });

  it('refuses an admin actor from removing an owner member even when other owners remain', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // actor lookup (admin), then target lookup (another owner).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-admin',
        orgId: 'org-1',
        userId: 'u-admin',
        role: 'admin',
      })
      .mockResolvedValueOnce({
        id: 'm-other-owner',
        orgId: 'org-1',
        userId: 'u-other-owner',
        role: 'owner',
      });
    // ownerCount = 2 so the ownerCount<=1 guard would otherwise let the delete proceed.
    prisma.orgMember.count.mockResolvedValue(2);

    const promise = removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-admin',
        userId: 'u-other-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.delete).not.toHaveBeenCalled();
  });
});
