import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  createTeamInvites,
  trackTeamInviteOpen,
} from '../../src/services/team-invite.service.management.js';
import { createMemberInvite } from '../../src/services/team-invite.service.member.js';
import { resendTeamInvite } from '../../src/services/team-invite.service.resend.js';
import { testUiTheme } from '../helpers/test-config.js';

/**
 * A2.1a legacy-owner safety: the contract-alignment cleanup leaves terminal
 * owner-role rows behind (revoked, often still stamped approvalStatus PENDING,
 * or DENIED). Every findFirst/updateMany in the create/resend/tracking paths
 * that identifies or supersedes a current same-email invite must filter through
 * ACTIONABLE_TEAM_INVITE_WHERE so those rows are invisible to all updates.
 * These tests fake Prisma and assert the exact where clauses.
 */

const ACTIONABLE_PREDICATE = {
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  approvalStatus: { not: 'DENIED' },
};

function expectActionableWhere(where: Record<string, unknown>) {
  expect(where).toMatchObject(ACTIONABLE_PREDICATE);
}

function makeConfig(overrides?: Partial<ClientConfig>): ClientConfig {
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

function makeEnv() {
  return {
    NODE_ENV: 'test' as const,
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info' as const,
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled' as const,
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
  };
}

const NOW = new Date('2026-08-14T00:00:00.000Z');

// The legacy terminal owner row left behind by the contract-alignment cleanup:
// DENIED-stamped and therefore never actionable.
const LEGACY_OWNER_ROW = {
  id: 'invite-legacy-owner',
  orgId: 'org-1',
  teamId: 'team-1',
  email: 'legacy-owner@example.com',
  inviteName: 'Legacy Owner',
  teamRole: 'owner',
  redirectUrl: null,
  invitedByUserId: 'founder-1',
  invitedByName: 'Founder',
  invitedByEmail: 'founder@example.com',
  acceptedUserId: null,
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  openedAt: null,
  openCount: 0,
  lastSentAt: new Date('2025-01-01T00:00:00.000Z'),
  expiresAt: null,
  approvalStatus: 'DENIED',
  requestedByUserId: null,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-02T00:00:00.000Z'),
};

function makeBasePrisma() {
  return {
    organisation: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'org-1',
        domain: 'client.example.com',
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
        memberInvites: 'allowed',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    team: {
      findFirst: vi.fn().mockResolvedValue({ id: 'team-1', name: 'Core Team' }),
    },
    teamInvite: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    teamMember: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    orgMember: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    verificationToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'token-row' }),
    },
  } as unknown as PrismaClient & {
    teamInvite: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    user: { findUnique: ReturnType<typeof vi.fn> };
    orgMember: { findFirst: ReturnType<typeof vi.fn> };
  };
}

function makeDeps(prisma: PrismaClient) {
  return {
    env: makeEnv(),
    prisma,
    now: () => NOW,
    sharedSecret: 'test-shared-secret-with-enough-length',
    generateEmailToken: () => 'token-123',
    hashEmailToken: () => 'hash-123',
    sendTeamInviteEmail: vi.fn(async () => undefined),
  };
}

function createdInviteRow(overrides?: Record<string, unknown>) {
  return {
    id: 'invite-new',
    orgId: 'org-1',
    teamId: 'team-1',
    email: 'legacy-owner@example.com',
    inviteName: null,
    teamRole: 'member',
    redirectUrl: null,
    invitedByUserId: 'owner-1',
    invitedByName: null,
    invitedByEmail: null,
    acceptedUserId: null,
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    openedAt: null,
    openCount: 0,
    lastSentAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    approvalStatus: 'NOT_REQUIRED',
    requestedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('legacy owner/DENIED invite rows are invisible to update paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('management create: findFirst and supersede updateMany use the actionable predicate', async () => {
    const prisma = makeBasePrisma();
    // No actionable same-email invite exists (only the invisible legacy DENIED owner row).
    prisma.teamInvite.findFirst.mockResolvedValue(null);
    prisma.teamInvite.create.mockResolvedValue(createdInviteRow());
    const deps = makeDeps(prisma);

    const result = await createTeamInvites(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        invitedBy: { userId: 'owner-1', name: 'Owner', email: 'owner@example.com' },
        invites: [{ email: 'legacy-owner@example.com', teamRole: 'admin' }],
      },
      deps,
    );

    // A normal new admin invite proceeds even though a legacy owner DENIED row exists.
    expect(result.results[0]).toMatchObject({
      email: 'legacy-owner@example.com',
      status: 'invited',
    });
    expect(prisma.teamInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ teamRole: 'admin', email: 'legacy-owner@example.com' }),
      }),
    );

    expectActionableWhere(prisma.teamInvite.findFirst.mock.calls[0][0].where);
    // No supersede write needed — and if one ran it must carry the predicate too.
    for (const call of prisma.teamInvite.updateMany.mock.calls) {
      expectActionableWhere(call[0].where);
    }
  });

  it('management create: supersede updateMany revokes only actionable same-email invites', async () => {
    const prisma = makeBasePrisma();
    prisma.teamInvite.findFirst.mockResolvedValue({
      ...createdInviteRow({ id: 'invite-actionable' }),
    });
    prisma.teamInvite.create.mockResolvedValue(createdInviteRow());
    const deps = makeDeps(prisma);

    const result = await createTeamInvites(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        invites: [{ email: 'legacy-owner@example.com' }],
      },
      deps,
    );

    expect(result.results[0]).toMatchObject({ status: 'resent_existing' });
    expect(prisma.teamInvite.updateMany).toHaveBeenCalledTimes(1);
    const where = prisma.teamInvite.updateMany.mock.calls[0][0].where;
    expectActionableWhere(where);
    expect(where).toMatchObject({ teamId: 'team-1', email: 'legacy-owner@example.com' });
  });

  it('member create: findFirst and supersede updateMany use the actionable predicate', async () => {
    const prisma = makeBasePrisma();
    // Actor is an org owner, so no teamMember lookup gates the flow.
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'owner-1',
      role: 'owner',
    });
    // The only same-email row is the legacy DENIED owner invite — invisible, so create proceeds.
    prisma.teamInvite.findFirst.mockResolvedValue(null);
    prisma.teamInvite.create.mockResolvedValue(createdInviteRow());
    const deps = makeDeps(prisma);

    const result = await createMemberInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        actorUserId: 'owner-1',
        invite: { email: 'legacy-owner@example.com', teamRole: 'member' },
      },
      deps,
    );

    expect(result).toEqual({ status: 'ok' });
    expect(prisma.teamInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvalStatus: 'NOT_REQUIRED' }),
      }),
    );
    expect(deps.sendTeamInviteEmail).toHaveBeenCalledTimes(1);

    expectActionableWhere(prisma.teamInvite.findFirst.mock.calls[0][0].where);
    for (const call of prisma.teamInvite.updateMany.mock.calls) {
      expectActionableWhere(call[0].where);
    }
  });

  it('member create: supersede updateMany revokes only actionable same-email invites', async () => {
    const prisma = makeBasePrisma();
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'owner-1',
      role: 'owner',
    });
    prisma.teamInvite.findFirst.mockResolvedValue({
      id: 'invite-actionable',
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
    });
    prisma.teamInvite.create.mockResolvedValue(createdInviteRow());
    const deps = makeDeps(prisma);

    await createMemberInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        actorUserId: 'owner-1',
        invite: { email: 'legacy-owner@example.com' },
      },
      deps,
    );

    expect(prisma.teamInvite.updateMany).toHaveBeenCalledTimes(1);
    const where = prisma.teamInvite.updateMany.mock.calls[0][0].where;
    expectActionableWhere(where);
    expect(where).toMatchObject({ teamId: 'team-1', email: 'legacy-owner@example.com' });
  });

  it('resend: same-email revoke updateMany never addresses the legacy owner row', async () => {
    const prisma = makeBasePrisma();
    prisma.teamInvite.findFirst.mockResolvedValue(createdInviteRow({ id: 'invite-current' }));
    prisma.teamInvite.create.mockResolvedValue(createdInviteRow({ id: 'invite-resent' }));
    const deps = makeDeps(prisma);

    await resendTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-current',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      deps,
    );

    expect(prisma.teamInvite.updateMany).toHaveBeenCalledTimes(1);
    const where = prisma.teamInvite.updateMany.mock.calls[0][0].where;
    expectActionableWhere(where);
    expect(where).toMatchObject({ teamId: 'team-1', email: 'legacy-owner@example.com' });
  });

  it('resend: the legacy owner invite itself cannot be resent (role rail)', async () => {
    const prisma = makeBasePrisma();
    prisma.teamInvite.findFirst.mockResolvedValue(LEGACY_OWNER_ROW);
    const deps = makeDeps(prisma);

    await expect(
      resendTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: LEGACY_OWNER_ROW.id,
          domain: 'client.example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(prisma.teamInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(deps.sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it('tracking pixel: both updateMany calls carry the actionable predicate', async () => {
    const prisma = makeBasePrisma();
    const deps = makeDeps(prisma);

    await trackTeamInviteOpen({ inviteId: LEGACY_OWNER_ROW.id }, deps);

    expect(prisma.teamInvite.updateMany).toHaveBeenCalledTimes(2);
    for (const call of prisma.teamInvite.updateMany.mock.calls) {
      expectActionableWhere(call[0].where);
      expect(call[0].where).toMatchObject({ id: LEGACY_OWNER_ROW.id });
    }
  });
});
