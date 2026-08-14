import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  normalizeInviteGrantRole,
  type InviteDeps,
} from '../../src/services/team-invite.service.base.js';
import { createTeamInvites } from '../../src/services/team-invite.service.management.js';
import {
  createMemberInvite,
  listPendingApprovalInvites,
} from '../../src/services/team-invite.service.member.js';
import { resendTeamInvite } from '../../src/services/team-invite.service.resend.js';
import { AppError } from '../../src/utils/errors.js';
import { testUiTheme } from '../helpers/test-config.js';

/**
 * A2.1a follow-up: the invite role-grant rail (`member`/`admin` only — never
 * `owner`) is enforced at the service boundary on every create/resend path
 * BEFORE any write, so owner attempts fail with the generic BAD_REQUEST
 * rather than a raw DB constraint error, and legacy owner-role rows can never
 * be resent into the member/admin-only CHECK.
 */

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

function makeInvitePrisma() {
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
    team: { findFirst: vi.fn().mockResolvedValue({ id: 'team-1', name: 'Core Team' }) },
    orgMember: { findFirst: vi.fn() },
    teamMember: { findFirst: vi.fn() },
    teamInvite: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    verificationToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'token-row' }),
    },
  } as unknown as PrismaClient;
}

function makeDeps(prisma: PrismaClient): InviteDeps {
  return {
    env: makeEnv(),
    prisma,
    now: () => new Date('2026-08-14T00:00:00.000Z'),
    sharedSecret: 'test-shared-secret-with-enough-length',
    generateEmailToken: () => 'token-123',
    hashEmailToken: () => 'hash-123',
  };
}

describe('normalizeInviteGrantRole', () => {
  it('allows member/admin (case-insensitive, trimmed) and defaults to member', () => {
    expect(normalizeInviteGrantRole(undefined)).toBe('member');
    expect(normalizeInviteGrantRole('member')).toBe('member');
    expect(normalizeInviteGrantRole(' Admin ')).toBe('admin');
  });

  it.each(['owner', 'OWNER', 'superuser', '', 'administrator'])(
    'rejects %s with the generic validation error',
    (role) => {
      try {
        normalizeInviteGrantRole(role);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe('BAD_REQUEST');
      }
    },
  );
});

describe('createTeamInvites (backend bulk path)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an owner grant before any invite write or email lookup', async () => {
    const prisma = makeInvitePrisma();
    await expect(
      createTeamInvites(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'client.example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
          invites: [{ email: 'boss@example.com', teamRole: 'owner' }],
        },
        makeDeps(prisma),
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'BAD_REQUEST' });
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(prisma.teamInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
  });
});

describe('createMemberInvite (member-initiated path)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an owner grant with BAD_REQUEST even for an org-admin actor', async () => {
    const prisma = makeInvitePrisma();
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'admin-1',
      role: 'admin',
    });
    await expect(
      createMemberInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'client.example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
          actorUserId: 'admin-1',
          invite: { email: 'boss@example.com', teamRole: 'OWNER' },
        },
        { ...makeDeps(prisma), sendTeamInviteEmail: vi.fn(async () => undefined) },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'BAD_REQUEST' });
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(prisma.teamInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('resendTeamInvite (stored-role rail)', () => {
  function legacyOwnerInvite() {
    return {
      id: 'invite-legacy-owner',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'legacy-owner@example.com',
      inviteName: null,
      teamRole: 'owner',
      redirectUrl: null,
      invitedByUserId: 'owner-1',
      invitedByName: 'Owner',
      invitedByEmail: 'owner@example.com',
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date('2026-08-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
  }

  it('refuses to resend a legacy owner-role invite with the generic BAD_REQUEST', async () => {
    const prisma = makeInvitePrisma();
    prisma.teamInvite.findFirst.mockResolvedValue(legacyOwnerInvite());
    await expect(
      resendTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-legacy-owner',
          domain: 'client.example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        { ...makeDeps(prisma), sendTeamInviteEmail: vi.fn(async () => undefined) },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'BAD_REQUEST' });
    // No revocation write, no replacement row, no token, no email.
    expect(prisma.teamInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
  });

  it('resends a member-role invite unchanged', async () => {
    const prisma = makeInvitePrisma();
    prisma.teamInvite.findFirst.mockResolvedValue({ ...legacyOwnerInvite(), teamRole: 'admin' });
    prisma.teamInvite.create.mockResolvedValue({
      ...legacyOwnerInvite(),
      id: 'invite-new',
      teamRole: 'admin',
    });
    const sendTeamInviteEmail = vi.fn(async () => undefined);
    await resendTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-legacy-owner',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      { ...makeDeps(prisma), sendTeamInviteEmail },
    );
    expect(prisma.teamInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ teamRole: 'admin' }) }),
    );
    expect(sendTeamInviteEmail).toHaveBeenCalledOnce();
  });
});

describe('listPendingApprovalInvites (actionable PENDING filter)', () => {
  const NOW = new Date('2026-08-14T00:00:00.000Z');

  it('queries only unresolved, non-expired PENDING invites', async () => {
    const prisma = makeInvitePrisma();
    await listPendingApprovalInvites(
      { orgId: 'org-1', domain: 'client.example.com' },
      { env: makeEnv(), prisma, now: () => NOW },
    );
    expect(prisma.teamInvite.findMany).toHaveBeenCalledWith({
      where: {
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        approvalStatus: 'PENDING',
        orgId: 'org-1',
        OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
      },
      orderBy: { createdAt: 'desc' },
      select: expect.any(Object),
    });
  });

  it('excludes every resolved or expired row even if a database returned one', async () => {
    const prisma = makeInvitePrisma();
    const base = {
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'row@example.com',
      inviteName: null,
      teamRole: 'member',
      redirectUrl: null,
      invitedByUserId: null,
      invitedByName: null,
      invitedByEmail: null,
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: NOW,
      requestedByUserId: 'member-1',
      createdAt: NOW,
      updatedAt: NOW,
    };
    // What the Prisma filter leaves for the org: one live PENDING invite.
    // APPROVED / NOT_REQUIRED / denied / accepted / declined / revoked rows
    // and any expired PENDING row (e.g. a legacy owner invite terminalized by
    // the contract-alignment migration while still stamped PENDING) never
    // make it past the where clause above.
    prisma.teamInvite.findMany.mockResolvedValue([
      { ...base, id: 'live', approvalStatus: 'PENDING', expiresAt: new Date('2026-09-01T00:00:00.000Z') },
    ]);

    const result = await listPendingApprovalInvites(
      { orgId: 'org-1', domain: 'client.example.com' },
      { env: makeEnv(), prisma, now: () => NOW },
    );
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 'live', approvalStatus: 'pending' });
    // The filter the row survived contains no path for these states.
    const where = (prisma.teamInvite.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].where;
    expect(where.approvalStatus).toBe('PENDING'); // not APPROVED / NOT_REQUIRED / DENIED
    expect(where.revokedAt).toBeNull();
    expect(where.declinedAt).toBeNull();
    expect(where.acceptedAt).toBeNull();
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: NOW } }]);
  });
});
