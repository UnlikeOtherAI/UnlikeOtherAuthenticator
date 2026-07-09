import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  createOrganisation,
  deleteOrganisation,
  getOrganisation,
  listOrganisationsForDomain,
  updateOrganisation,
} from '../../src/services/organisation.service.organisation.js';

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
      findUniqueOrThrow: vi.fn(),
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

describe('Organisation service: organisation CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    randomBytes.mockReset();
    randomBytes.mockReturnValue(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAuthServiceIdentifier;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('creates an organisation, owner membership, and default team', async () => {
    const prisma = makePrismaMock();

    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-owner' });
    prisma.organisation.findFirst.mockResolvedValue(null);
    prisma.organisation.create.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme Inc',
      slug: 'acme-inc',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue(null);
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
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.teamMember.create.mockResolvedValue({
      id: 'tm-owner',
      teamId: 'team-default',
      userId: 'u-owner',
      teamRole: 'member',
      createdAt: now,
      updatedAt: now,
    });

    const org = await createOrganisation(
      {
        domain: 'Acme.Example.com',
        name: 'Acme Inc',
        ownerId: 'u-owner',
        config: makeConfig(),
      },
      { prisma },
    );

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
        data: expect.objectContaining({
          orgId: 'org-1',
          name: 'General',
          slug: 'general',
          isDefault: true,
        }),
      }),
    );
    expect(prisma.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          teamId: 'team-default',
          userId: 'u-owner',
        },
      }),
    );
  });

  it('rejects creating an org when owner already belongs to another org on the domain', async () => {
    const prisma = makePrismaMock();

    prisma.orgMember.findFirst.mockResolvedValue({ id: 'existing-member' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u-owner' });

    const promise = createOrganisation(
      {
        domain: 'acme.example.com',
        name: 'Second org',
        ownerId: 'u-owner',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.organisation.create).not.toHaveBeenCalled();
  });

  it('regenerates slug with random suffix when the base slug collides', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst
      .mockResolvedValueOnce({
        id: 'org-1',
        domain: 'acme.example.com',
        name: 'Original',
        slug: 'original',
        ownerId: 'u-owner',
        createdAt: now,
        updatedAt: now,
      })
      .mockResolvedValueOnce({ id: 'other-org' })
      .mockResolvedValueOnce(null);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.organisation.update.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme-aaaa',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });

    const result = await updateOrganisation(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        name: 'Acme',
        actorUserId: 'u-owner',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1' },
        data: expect.objectContaining({
          name: 'Acme',
          slug: 'acme-aaaa',
        }),
      }),
    );
    expect(result.slug).toBe('acme-aaaa');
    expect(randomBytes).toHaveBeenCalledTimes(1);
  });

  // icon_url validation coverage (accept https, clear on null, reject http/oversized) lives in
  // organisation.service.icon-url.test.ts (CLAUDE.md 500-line split).

  it('lists organisations for a domain with cursor pagination', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findMany.mockResolvedValue([
      {
        id: 'org-new',
        domain: 'acme.example.com',
        name: 'New',
        slug: 'new',
        ownerId: 'u-owner',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'org-old',
        domain: 'acme.example.com',
        name: 'Old',
        slug: 'old',
        ownerId: 'u-owner',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await listOrganisationsForDomain(
      { domain: 'Acme.Example.com', limit: 1 },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'org-new', slug: 'new' }],
      next_cursor: 'org-old',
    });
    expect(prisma.organisation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { domain: 'acme.example.com' },
        take: 2,
      }),
    );
  });

  it('reads an organisation from its domain and id', async () => {
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
      id: 'm-actor',
      orgId: 'org-1',
      userId: 'u-actor',
      role: 'member',
    });

    const org = await getOrganisation(
      { orgId: 'org-1', domain: 'Acme.Example.com', actorUserId: 'u-actor' },
      { prisma },
    );

    expect(prisma.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1', domain: 'acme.example.com' },
      }),
    );
    expect(org).toMatchObject({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
    });
  });

  it('refuses to read an organisation when the actor has no membership', async () => {
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
    prisma.orgMember.findFirst.mockResolvedValue(null);

    const promise = getOrganisation(
      { orgId: 'org-1', domain: 'acme.example.com', actorUserId: 'u-stranger' },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('deletes an organisation when called by the owner', async () => {
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
    prisma.organisation.delete.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });

    const result = await deleteOrganisation(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    expect(result).toEqual({ deleted: true });
    expect(prisma.organisation.delete).toHaveBeenCalledWith({ where: { id: 'org-1' } });
  });

  it('forbids deleting an organisation when caller is not the owner', async () => {
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

    const promise = deleteOrganisation(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-not-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    expect(prisma.organisation.delete).not.toHaveBeenCalled();
  });
});
