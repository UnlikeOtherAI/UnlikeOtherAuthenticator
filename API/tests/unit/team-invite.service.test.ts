import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTeamInvites } from '../../src/services/team-invite.service.management.js';
import { toInviteRecord } from '../../src/services/team-invite.service.base.js';
import { makeConfig, makeInvitePrisma } from '../helpers/team-invite-fixtures.js';

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
      expiresAt: null,
      approvalStatus: 'NOT_REQUIRED',
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
        now: () => new Date('2026-03-01T00:00:00.000Z'),
        sharedSecret: 'test-shared-secret-with-enough-length',
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
    // The per-row result carries the created invitation's id, so a caller can read, resend, or
    // revoke that exact invitation by id without listing the team's whole invite history.
    expect(result.results[0]).toHaveProperty('invite.id', 'invite-1');
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
      expiresAt: null,
      approvalStatus: 'NOT_REQUIRED',
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
      expiresAt: null,
      approvalStatus: 'NOT_REQUIRED',
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
        now: () => new Date('2026-03-03T00:00:00.000Z'),
        sharedSecret: 'test-shared-secret-with-enough-length',
        generateEmailToken: () => 'token-456',
        hashEmailToken: () => 'hash-456',
        sendTeamInviteEmail: vi.fn(async () => undefined),
      },
    );

    expect(result.results[0]).toMatchObject({
      email: 'invitee@example.com',
      status: 'resent_existing',
    });
    // A resend supersedes the previous row, so the id returned is the fresh invitation's — the one
    // a by-id read/resend/revoke has to target.
    expect(result.results[0]).toHaveProperty('invite.id', 'invite-new');
    expect(prisma.teamInvite.updateMany).toHaveBeenCalledWith({
      where: {
        teamId: 'team-1',
        email: 'invitee@example.com',
        // The actionable predicate — the same one `team_invites_one_actionable_per_team_email`
        // enforces. A DENIED invite is already non-actionable, so it is never re-revoked.
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        approvalStatus: { not: 'DENIED' },
      },
      data: {
        revokedAt: new Date('2026-03-03T00:00:00.000Z'),
        // Superseding is labelled REPLACED so an explicit revocation (REVOKED) stays
        // distinguishable in the derived status.
        revokedReason: 'REPLACED',
      },
    });
  });

  it('does not create an invite token or send email for an existing user when inline sign-in is enabled', async () => {
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
    prisma.user.findUnique.mockResolvedValue({ id: 'user-existing' });
    prisma.teamMember.findFirst.mockResolvedValue(null);
    prisma.orgMember.findFirst.mockResolvedValue(null);

    const sendTeamInviteEmail = vi.fn(async () => undefined);

    const result = await createTeamInvites(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'client.example.com',
        config: makeConfig({ existing_user_registration_behavior: 'inline_sign_in' }),
        configUrl: 'https://client.example.com/auth-config',
        invites: [{ email: 'existing@example.com', name: 'Existing User' }],
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
        now: () => new Date('2026-03-04T00:00:00.000Z'),
        sharedSecret: 'test-shared-secret-with-enough-length',
        generateEmailToken: () => 'token-existing',
        hashEmailToken: () => 'hash-existing',
        sendTeamInviteEmail,
      },
    );

    expect(result.results).toEqual([
      { email: 'existing@example.com', status: 'existing_user' },
    ]);
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
    expect(sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  describe('Phase 4: invite expiry (Task 3)', () => {
    const baseRow = {
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invitee@example.com',
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
      lastSentAt: new Date('2026-01-01T00:00:00.000Z'),
      approvalStatus: 'NOT_REQUIRED',
      requestedByUserId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    it('derives "expired" when expiresAt is in the past and the invite is otherwise unresolved', () => {
      const record = toInviteRecord(
        { ...baseRow, expiresAt: new Date('2026-01-31T00:00:00.000Z') },
        new Date('2026-02-01T00:00:00.000Z'),
      );
      expect(record.status).toBe('expired');
    });

    it('stays "pending" when expiresAt is in the future', () => {
      const record = toInviteRecord(
        { ...baseRow, expiresAt: new Date('2026-02-28T00:00:00.000Z') },
        new Date('2026-02-01T00:00:00.000Z'),
      );
      expect(record.status).toBe('pending');
    });

    it('an already-accepted invite is never "expired" even past its expiresAt', () => {
      const record = toInviteRecord(
        {
          ...baseRow,
          acceptedAt: new Date('2026-01-15T00:00:00.000Z'),
          acceptedUserId: 'user-1',
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        },
        new Date('2026-02-01T00:00:00.000Z'),
      );
      expect(record.status).toBe('accepted');
    });

    it('lowercases approvalStatus onto the record', () => {
      const record = toInviteRecord({ ...baseRow, approvalStatus: 'PENDING', expiresAt: null });
      expect(record.approvalStatus).toBe('pending');
    });
  });
});
