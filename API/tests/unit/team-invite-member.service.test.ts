import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  approveInvite,
  createMemberInvite,
  denyInvite,
  listPendingApprovalInvites,
} from '../../src/services/team-invite.service.member.js';
import { testUiTheme } from '../helpers/test-config.js';

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

function makePrisma(memberInvites = 'allowed') {
  return {
    organisation: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'org-1',
        domain: 'client.example.com',
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
        memberInvites,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    team: {
      findFirst: vi.fn().mockResolvedValue({ id: 'team-1', name: 'Core Team' }),
    },
    orgMember: {
      findFirst: vi.fn(),
    },
    teamMember: {
      findFirst: vi.fn(),
    },
    teamInvite: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    verificationToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'token-row' }),
    },
  } as unknown as PrismaClient;
}

const inviteDeps = (prisma: PrismaClient, memberInvitesActor?: string) => ({
  env: makeEnv(),
  prisma,
  now: () => new Date('2026-04-01T00:00:00.000Z'),
  sharedSecret: 'test-shared-secret-with-enough-length',
  generateEmailToken: () => 'token-123',
  hashEmailToken: () => 'hash-123',
  sendTeamInviteEmail: vi.fn(async () => undefined),
  ...(memberInvitesActor ? {} : {}),
});

describe('member-initiated invites (Phase 4 Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('org owner/admin: always allowed, NOT_REQUIRED, sends email immediately', async () => {
    const prisma = makePrisma('disabled');
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'admin-1',
      role: 'admin',
    });
    prisma.teamInvite.create.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'new@example.com',
      inviteName: null,
      teamRole: 'member',
      redirectUrl: null,
      invitedByUserId: 'admin-1',
      invitedByName: null,
      invitedByEmail: null,
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      approvalStatus: 'NOT_REQUIRED',
      requestedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const deps = inviteDeps(prisma);
    const result = await createMemberInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        actorUserId: 'admin-1',
        invite: { email: 'new@example.com' },
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
  });

  it('plain member + memberInvites "allowed": NOT_REQUIRED, sends email', async () => {
    const prisma = makePrisma('allowed');
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'member-1',
      role: 'member',
    });
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });
    prisma.teamInvite.create.mockResolvedValue({
      id: 'invite-2',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'new@example.com',
      inviteName: null,
      teamRole: 'member',
      redirectUrl: null,
      invitedByUserId: 'member-1',
      invitedByName: null,
      invitedByEmail: null,
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      approvalStatus: 'NOT_REQUIRED',
      requestedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const deps = inviteDeps(prisma);
    const result = await createMemberInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        actorUserId: 'member-1',
        invite: { email: 'new@example.com' },
      },
      deps,
    );

    expect(result).toEqual({ status: 'ok' });
    expect(deps.sendTeamInviteEmail).toHaveBeenCalledTimes(1);
  });

  it('plain member + memberInvites "admin_approval": creates PENDING and sends NO email', async () => {
    const prisma = makePrisma('admin_approval');
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'member-1',
      role: 'member',
    });
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });
    prisma.teamInvite.create.mockResolvedValue({
      id: 'invite-3',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'new@example.com',
      inviteName: null,
      teamRole: 'member',
      redirectUrl: null,
      invitedByUserId: 'member-1',
      invitedByName: null,
      invitedByEmail: null,
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      approvalStatus: 'PENDING',
      requestedByUserId: 'member-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const deps = inviteDeps(prisma);
    const result = await createMemberInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        actorUserId: 'member-1',
        invite: { email: 'new@example.com' },
      },
      deps,
    );

    expect(result).toEqual({ status: 'ok' });
    expect(prisma.teamInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalStatus: 'PENDING',
          requestedByUserId: 'member-1',
        }),
      }),
    );
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
    expect(deps.sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it('plain member + memberInvites "disabled": rejected generically', async () => {
    const prisma = makePrisma('disabled');
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'member-1',
      role: 'member',
    });
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });

    const deps = inviteDeps(prisma);
    await expect(
      createMemberInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'client.example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
          actorUserId: 'member-1',
          invite: { email: 'new@example.com' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
  });

  it('a deactivated (non-ACTIVE) actor cannot invite', async () => {
    const prisma = makePrisma('allowed');
    prisma.orgMember.findFirst.mockResolvedValue(null); // activeOnly lookup finds nothing

    const deps = inviteDeps(prisma);
    await expect(
      createMemberInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'client.example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
          actorUserId: 'deactivated-1',
          invite: { email: 'new@example.com' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
  });

  it('does not reveal whether the invitee already has an account (no enumeration)', async () => {
    const prisma = makePrisma('allowed');
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-1',
      orgId: 'org-1',
      userId: 'admin-1',
      role: 'admin',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'existing-user' });
    prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-existing' }); // already a member

    const deps = inviteDeps(prisma);
    const result = await createMemberInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        actorUserId: 'admin-1',
        invite: { email: 'existing@example.com' },
      },
      deps,
    );

    expect(result).toEqual({ status: 'ok' });
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
  });
});

describe('invite approval workflow (Phase 4 Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists PENDING invites for approval', async () => {
    const prisma = makePrisma();
    (prisma as unknown as { teamInvite: { findMany: ReturnType<typeof vi.fn> } }).teamInvite.findMany =
      vi.fn().mockResolvedValue([
        {
          id: 'invite-1',
          orgId: 'org-1',
          teamId: 'team-1',
          email: 'pending@example.com',
          inviteName: null,
          teamRole: 'member',
          redirectUrl: null,
          invitedByUserId: 'member-1',
          invitedByName: null,
          invitedByEmail: null,
          acceptedUserId: null,
          acceptedAt: null,
          declinedAt: null,
          revokedAt: null,
          openedAt: null,
          openCount: 0,
          lastSentAt: new Date(),
          expiresAt: new Date('2026-05-01T00:00:00.000Z'),
          approvalStatus: 'PENDING',
          requestedByUserId: 'member-1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

    const result = await listPendingApprovalInvites(
      { orgId: 'org-1', domain: 'client.example.com' },
      { env: makeEnv(), prisma, now: () => new Date('2026-04-01T00:00:00.000Z') },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 'invite-1', approvalStatus: 'pending' });
  });

  it('approve: sets APPROVED and sends the invite email', async () => {
    const prisma = makePrisma();
    const inviteRow = {
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'pending@example.com',
      inviteName: null,
      teamRole: 'member',
      redirectUrl: null,
      invitedByUserId: 'member-1',
      invitedByName: null,
      invitedByEmail: null,
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      approvalStatus: 'PENDING',
      requestedByUserId: 'member-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      team: { id: 'team-1', name: 'Core Team' },
      org: { name: 'Acme', domain: 'client.example.com' },
    };
    (prisma as unknown as { teamInvite: { findFirst: ReturnType<typeof vi.fn> } }).teamInvite.findFirst =
      vi.fn().mockResolvedValue(inviteRow);
    prisma.teamInvite.update.mockResolvedValue({ ...inviteRow, approvalStatus: 'APPROVED' });

    const deps = inviteDeps(prisma);
    const result = await approveInvite(
      {
        orgId: 'org-1',
        domain: 'client.example.com',
        inviteId: 'invite-1',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        reviewerUserId: 'admin-1',
      },
      deps,
    );

    expect(result.approvalStatus).toBe('approved');
    expect(prisma.teamInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: { approvalStatus: 'APPROVED' },
      select: expect.any(Object),
    });
    expect(deps.sendTeamInviteEmail).toHaveBeenCalledTimes(1);
  });

  it('deny: sets DENIED and sends nothing', async () => {
    const prisma = makePrisma();
    const inviteRow = {
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'pending@example.com',
      inviteName: null,
      teamRole: 'member',
      redirectUrl: null,
      invitedByUserId: 'member-1',
      invitedByName: null,
      invitedByEmail: null,
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      approvalStatus: 'PENDING',
      requestedByUserId: 'member-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      team: { id: 'team-1', name: 'Core Team' },
      org: { name: 'Acme', domain: 'client.example.com' },
    };
    (prisma as unknown as { teamInvite: { findFirst: ReturnType<typeof vi.fn> } }).teamInvite.findFirst =
      vi.fn().mockResolvedValue(inviteRow);
    prisma.teamInvite.update.mockResolvedValue({ ...inviteRow, approvalStatus: 'DENIED' });

    const result = await denyInvite(
      { orgId: 'org-1', domain: 'client.example.com', inviteId: 'invite-1', reviewerUserId: 'admin-1' },
      { env: makeEnv(), prisma, now: () => new Date('2026-04-01T00:00:00.000Z') },
    );

    expect(result.approvalStatus).toBe('denied');
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
  });
});
