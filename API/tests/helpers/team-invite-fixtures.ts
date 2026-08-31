import { vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from './test-config.js';

export function makeConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
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
    },
    ...overrides,
  } as ClientConfig;
}

export function makeAcceptanceTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    teamInvite: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    orgMember: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    teamMember: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as Prisma.TransactionClient;
}

export function makeInvitePrisma() {
  return {
    organisation: {
      findFirst: vi.fn(),
    },
    team: {
      findFirst: vi.fn(),
    },
    teamInvite: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    teamMember: {
      findFirst: vi.fn(),
    },
    orgMember: {
      findFirst: vi.fn(),
    },
    verificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as PrismaClient;
}
