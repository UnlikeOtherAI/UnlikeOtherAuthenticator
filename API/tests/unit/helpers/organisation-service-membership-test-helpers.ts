import { afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../../src/services/config.service.js';

/**
 * Shared across the `organisation.service.membership*.test.ts` siblings (CLAUDE.md 500-line split
 * of the original `organisation.service.membership.test.ts`) — unchanged from the pre-split file,
 * only their location moved.
 */
export const now = new Date('2026-02-15T00:00:00.000Z');

export const baseOrg = {
  id: 'org-1',
  domain: 'acme.example.com',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'u-owner',
  createdAt: now,
  updatedAt: now,
};

export function makePrismaMock(): PrismaClient {
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
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  } as unknown as PrismaClient;

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma));

  return prisma;
}

export function makeConfig(overrides?: Partial<NonNullable<ClientConfig['org_features']>>): ClientConfig {
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

/**
 * `Organisation service: membership`'s env setup/teardown (full save + restore via afterAll) —
 * call once inside that file's top-level describe.
 */
export function useOrganisationMembershipTestEnv(): void {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAuthServiceIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalDatabaseUrl = process.env.DATABASE_URL;

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
}

/**
 * `Organisation service: member lifecycle (deactivate/reactivate)`'s env setup — matches the
 * pre-split file exactly: `beforeEach` only, no `afterAll` restore.
 */
export function useOrganisationMembershipLifecycleTestEnv(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
  });
}
