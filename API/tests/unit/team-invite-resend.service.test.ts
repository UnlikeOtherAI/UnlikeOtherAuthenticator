import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { resendTeamInvite } from '../../src/services/team-invite.service.resend.js';
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
    organisation: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
    teamInvite: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    verificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as PrismaClient;
}

describe('resendTeamInvite', () => {
  it('does not resend an invite email for an existing user when inline sign-in is enabled', async () => {
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
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1', name: 'Core Team' });
    prisma.teamInvite.findFirst.mockResolvedValue({
      id: 'invite-existing',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'existing@example.com',
      inviteName: 'Existing User',
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
      lastSentAt: new Date('2026-03-04T00:00:00.000Z'),
      createdAt: new Date('2026-03-04T00:00:00.000Z'),
      updatedAt: new Date('2026-03-04T00:00:00.000Z'),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'user-existing' });
    const sendTeamInviteEmail = vi.fn(async () => undefined);

    await expect(
      resendTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-existing',
          domain: 'client.example.com',
          config: makeConfig({ existing_user_registration_behavior: 'inline_sign_in' }),
          configUrl: 'https://client.example.com/auth-config',
        },
        {
          env: {
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: 3000,
            PUBLIC_BASE_URL: 'https://auth.example.com',
            LOG_LEVEL: 'info',
            SHARED_SECRET: 'test-shared-secret-with-enough-length',
            AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
            DATABASE_URL: 'postgres://example.invalid/db',
            ACCESS_TOKEN_TTL: '30m',
            LOG_RETENTION_DAYS: 90,
            AI_TRANSLATION_PROVIDER: 'disabled',
            OPENAI_API_KEY: undefined,
            OPENAI_MODEL: undefined,
          },
          prisma,
          now: () => new Date('2026-03-05T00:00:00.000Z'),
          sharedSecret: 'test-shared-secret-with-enough-length',
          generateEmailToken: () => 'token-existing',
          hashEmailToken: () => 'hash-existing',
          sendTeamInviteEmail,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'EMAIL_ALREADY_REGISTERED',
    });

    expect(prisma.teamInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
    expect(sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it('Phase 4: refreshes expiresAt to now + 30 days on resend', async () => {
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
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1', name: 'Core Team' });
    prisma.teamInvite.findFirst.mockResolvedValue({
      id: 'invite-old',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invitee@example.com',
      inviteName: null,
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
      lastSentAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      approvalStatus: 'NOT_REQUIRED',
      requestedByUserId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.teamInvite.updateMany.mockResolvedValue({ count: 1 });
    prisma.teamInvite.create.mockResolvedValue({
      id: 'invite-new',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invitee@example.com',
      inviteName: null,
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
      lastSentAt: new Date('2026-02-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-03T00:00:00.000Z'),
      approvalStatus: 'NOT_REQUIRED',
      requestedByUserId: null,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    prisma.verificationToken.updateMany.mockResolvedValue({ count: 0 });
    prisma.verificationToken.create.mockResolvedValue({ id: 'token-row-3' });

    const result = await resendTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-old',
        domain: 'client.example.com',
        config: makeConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: {
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: 3000,
          PUBLIC_BASE_URL: 'https://auth.example.com',
          LOG_LEVEL: 'info',
          SHARED_SECRET: 'test-shared-secret-with-enough-length',
          AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
          DATABASE_URL: 'postgres://example.invalid/db',
          ACCESS_TOKEN_TTL: '30m',
          LOG_RETENTION_DAYS: 90,
          AI_TRANSLATION_PROVIDER: 'disabled',
          OPENAI_API_KEY: undefined,
          OPENAI_MODEL: undefined,
        },
        prisma,
        now: () => new Date('2026-02-01T00:00:00.000Z'),
        sharedSecret: 'test-shared-secret-with-enough-length',
        generateEmailToken: () => 'token-new',
        hashEmailToken: () => 'hash-new',
        sendTeamInviteEmail: vi.fn(async () => undefined),
      },
    );

    expect(prisma.teamInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date('2026-03-03T00:00:00.000Z'),
        }),
      }),
    );
    expect(result.expiresAt).toEqual(new Date('2026-03-03T00:00:00.000Z'));
  });
});
