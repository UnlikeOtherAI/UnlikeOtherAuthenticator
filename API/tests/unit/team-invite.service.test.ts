import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.acceptance.js';
import { createTeamInvites } from '../../src/services/team-invite.service.management.js';
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

function makeInvitePrisma() {
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

function makeAcceptanceTx() {
  return {
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

describe('team invite services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending invite, issues a linked token, and sends an invite email', async () => {
    const prisma = makeInvitePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'client.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      name: 'Core Team',
    });
    prisma.teamInvite.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.teamInvite.create.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'new-user@example.com',
      inviteName: 'New User',
      teamRole: 'member',
      redirectUrl: 'https://client.example.com/oauth/callback',
      invitedByUserId: 'owner-1',
      invitedByName: 'Owner',
      invitedByEmail: 'owner@example.com',
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      openedAt: null,
      openCount: 0,
      lastSentAt: new Date('2026-03-01T00:00:00.000Z'),
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.verificationToken.updateMany.mockResolvedValue({ count: 0 });
    prisma.verificationToken.create.mockResolvedValue({ id: 'token-row-1' });

    const sendTeamInviteEmail = vi.fn(async () => undefined);

    const result = await createTeamInvites(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        redirectUrl: 'https://client.example.com/oauth/callback',
        invitedBy: {
          userId: 'owner-1',
          name: 'Owner',
          email: 'owner@example.com',
        },
        invites: [
          {
            email: 'new-user@example.com',
            name: 'New User',
          },
        ],
      },
      {
        env: {
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: 3000,
          PUBLIC_BASE_URL: 'https://auth.example.com',
          LOG_LEVEL: 'info',
          SHARED_SECRET: 'test-shared-secret',
          AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
          DATABASE_URL: 'postgres://example.invalid/db',
          ACCESS_TOKEN_TTL: '30m',
          LOG_RETENTION_DAYS: 90,
          AI_TRANSLATION_PROVIDER: 'disabled',
          OPENAI_API_KEY: undefined,
          OPENAI_MODEL: undefined,
        },
        prisma,
        now: () => new Date('2026-03-01T00:00:00.000Z'),
        sharedSecret: 'test-shared-secret',
        generateEmailToken: () => 'token-123',
        hashEmailToken: () => 'hash-123',
        sendTeamInviteEmail,
      },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      email: 'new-user@example.com',
      status: 'invited',
    });
    expect(prisma.verificationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        teamInviteId: 'invite-1',
        tokenHash: 'hash-123',
      }),
    });
    expect(sendTeamInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'new-user@example.com',
        organisationName: 'Acme',
        teamName: 'Core Team',
        trackingPixelUrl: 'https://auth.example.com/auth/email/team-invite-open/invite-1.gif',
      }),
    );
  });

  it('accepts a pending invite by creating memberships and marking the invite accepted', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      inviteName: 'Invited User',
      teamRole: 'lead',
      acceptedUserId: null,
      acceptedAt: null,
      revokedAt: null,
      org: {
        id: 'org-1',
        domain: 'client.example.com',
      },
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: null,
    });
    tx.user.update.mockResolvedValue({
      id: 'user-1',
      name: 'Invited User',
    });
    tx.orgMember.findFirst.mockResolvedValue(null);
    tx.orgMember.count.mockResolvedValue(1);
    tx.orgMember.create.mockResolvedValue({ id: 'org-member-1' });
    tx.teamMember.findFirst.mockResolvedValue(null);
    tx.teamMember.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    tx.teamMember.create.mockResolvedValue({ id: 'team-member-1' });
    tx.teamInvite.update.mockResolvedValue({ id: 'invite-1' });

    await acceptTeamInviteWithinTransaction({
      prisma: tx,
      teamInviteId: 'invite-1',
      userId: 'user-1',
      config: makeConfig(),
      now: new Date('2026-03-02T00:00:00.000Z'),
    });

    expect(tx.orgMember.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        userId: 'user-1',
        role: 'member',
      },
      select: { id: true },
    });
    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-1',
        userId: 'user-1',
        teamRole: 'lead',
      },
      select: { id: true },
    });
    expect(tx.teamInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: {
        acceptedAt: new Date('2026-03-02T00:00:00.000Z'),
        acceptedUserId: 'user-1',
      },
      select: { id: true },
    });
  });

  it('replaces an unresolved same-team invite with a freshly sent invite', async () => {
    const prisma = makeInvitePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'client.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      name: 'Core Team',
    });
    prisma.teamInvite.findFirst.mockResolvedValue({
      id: 'invite-old',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invitee@example.com',
      inviteName: 'Invitee',
      teamRole: 'member',
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
      lastSentAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.teamInvite.updateMany.mockResolvedValue({ count: 1 });
    prisma.teamInvite.create.mockResolvedValue({
      id: 'invite-new',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invitee@example.com',
      inviteName: 'Invitee',
      teamRole: 'member',
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
      lastSentAt: new Date('2026-03-03T00:00:00.000Z'),
      createdAt: new Date('2026-03-03T00:00:00.000Z'),
      updatedAt: new Date('2026-03-03T00:00:00.000Z'),
    });
    prisma.verificationToken.updateMany.mockResolvedValue({ count: 0 });
    prisma.verificationToken.create.mockResolvedValue({ id: 'token-row-2' });

    const result = await createTeamInvites(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
        invites: [{ email: 'invitee@example.com', name: 'Invitee' }],
      },
      {
        env: {
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: 3000,
          PUBLIC_BASE_URL: 'https://auth.example.com',
          LOG_LEVEL: 'info',
          SHARED_SECRET: 'test-shared-secret',
          AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
          DATABASE_URL: 'postgres://example.invalid/db',
          ACCESS_TOKEN_TTL: '30m',
          LOG_RETENTION_DAYS: 90,
          AI_TRANSLATION_PROVIDER: 'disabled',
          OPENAI_API_KEY: undefined,
          OPENAI_MODEL: undefined,
        },
        prisma,
        now: () => new Date('2026-03-03T00:00:00.000Z'),
        sharedSecret: 'test-shared-secret',
        generateEmailToken: () => 'token-456',
        hashEmailToken: () => 'hash-456',
        sendTeamInviteEmail: vi.fn(async () => undefined),
      },
    );

    expect(result.results[0]).toMatchObject({
      email: 'invitee@example.com',
      status: 'resent_existing',
    });
    expect(prisma.teamInvite.updateMany).toHaveBeenCalledWith({
      where: {
        teamId: 'team-1',
        email: 'invitee@example.com',
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date('2026-03-03T00:00:00.000Z'),
      },
    });
  });
});
