import { afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../../src/services/config.service.js';

/**
 * Shared across the `team.service.*.test.ts` siblings (CLAUDE.md 500-line split of the original
 * `team.service.test.ts`): a fixed "now", a Prisma mock builder, and a config builder, all
 * unchanged from the pre-split file — only their location moved.
 */
export const now = new Date('2026-02-15T00:00:00.000Z');

export function makePrismaMock(): PrismaClient {
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
    // Gap-fix A Task 2 (`?include=invited`): getTeam's invited-entries lookup.
    teamInvite: {
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked-row', isDefault: false }]),
    $transaction: vi.fn(),
  } as unknown as PrismaClient;

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(prisma),
  );

  return prisma;
}

export function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
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
 * Registers the same env-var setup/teardown every `team.service.*.test.ts` file needs. Call once
 * inside each file's top-level `describe` — mirrors the original single describe block's
 * `beforeEach`/`afterAll` exactly, just callable from multiple sibling files.
 */
export function useTeamServiceTestEnv(): void {
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
