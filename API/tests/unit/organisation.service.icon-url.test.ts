import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { updateOrganisation } from '../../src/services/organisation.service.organisation.js';

// CLAUDE.md 500-line split: gap-fix A Task 3's `icon_url` write/validation on
// `PUT /org/organisations/:orgId`, split out of organisation.service.create-update.test.ts to keep
// that file under the 500-line cap. Mock/config builders mirror that file's (undupe candidate is
// low-value here — the two files' Prisma mock surfaces already diverge and neither is shared via a
// helpers file today).

const now = new Date('2026-02-15T00:00:00.000Z');

function makePrismaMock() {
  const prisma = {
    organisation: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    orgMember: {
      findFirst: vi.fn(),
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

describe('Organisation service: updateOrganisation icon_url', () => {
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

  it('accepts an https icon_url and echoes it on the updated record', async () => {
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
    prisma.organisation.update.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      iconUrl: 'https://cdn.example.com/icon.png',
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
        iconUrl: 'https://cdn.example.com/icon.png',
      },
      { prisma },
    );

    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ iconUrl: 'https://cdn.example.com/icon.png' }),
      }),
    );
    expect(result.iconUrl).toBe('https://cdn.example.com/icon.png');
  });

  it('clears icon_url when explicitly set to null', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      iconUrl: 'https://cdn.example.com/old.png',
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
    prisma.organisation.update.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      iconUrl: null,
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
        iconUrl: null,
      },
      { prisma },
    );

    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ iconUrl: null }) }),
    );
    expect(result.iconUrl).toBeNull();
  });

  it('rejects a non-https icon_url with a generic error', async () => {
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

    const promise = updateOrganisation(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        name: 'Acme',
        actorUserId: 'u-owner',
        config: makeConfig(),
        iconUrl: 'http://cdn.example.com/icon.png',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.organisation.update).not.toHaveBeenCalled();
  });

  it('rejects an icon_url over 2048 characters with a generic error', async () => {
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

    const oversized = `https://cdn.example.com/${'a'.repeat(2048)}`;
    const promise = updateOrganisation(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        name: 'Acme',
        actorUserId: 'u-owner',
        config: makeConfig(),
        iconUrl: oversized,
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.organisation.update).not.toHaveBeenCalled();
  });
});
