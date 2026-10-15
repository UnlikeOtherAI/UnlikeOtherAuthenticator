import { asTransaction } from '../../helpers/directory-store.js';
import { afterAll, beforeEach, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from '../../../src/services/config.service.js';

export function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
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

export function makePrismaMock() {
  const prisma = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => sql.strings.join(' ').includes('uoa_group_membership_admission') ? [{ allowed: true }] : []),
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

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(asTransaction(prisma)));

  return prisma;
}

export const now = new Date('2026-02-15T00:00:00.000Z');
const originalNodeEnv = process.env.NODE_ENV;
const originalSharedSecret = process.env.SHARED_SECRET;
const originalAuthServiceIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
const originalDatabaseUrl = process.env.DATABASE_URL;

export function useGroupServiceEnv() {
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
