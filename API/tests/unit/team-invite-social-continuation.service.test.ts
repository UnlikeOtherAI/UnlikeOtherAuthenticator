import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';

const acceptTeamInviteWithinTransactionMock = vi.fn();

vi.mock('../../src/services/team-invite.service.acceptance.js', () => ({
  acceptTeamInviteWithinTransaction: (...args: unknown[]) =>
    acceptTeamInviteWithinTransactionMock(...args),
}));

const { acceptTeamInviteSocialContinuation } = await import(
  '../../src/services/team-invite.service.token.js'
);

const now = new Date('2026-04-01T00:00:00.000Z');

const config = {
  domain: 'client.example.com',
} as ClientConfig;

function tokenRow() {
  return {
    id: 'token-1',
    type: 'VERIFY_EMAIL_SET_PASSWORD',
    email: 'invitee@example.com',
    configUrl: 'https://client.example.com/auth-config',
    tokenVersion: null,
    userId: null,
    userKey: 'invitee@example.com',
    teamInviteId: 'invite-1',
    expiresAt: new Date('2026-04-01T00:10:00.000Z'),
    usedAt: null,
    teamInvite: {
      id: 'invite-1',
      inviteName: 'Invitee',
      email: 'invitee@example.com',
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      team: { name: 'Core team' },
      org: { name: 'Acme' },
    },
  };
}

describe('acceptTeamInviteSocialContinuation', () => {
  beforeEach(() => {
    acceptTeamInviteWithinTransactionMock.mockReset().mockResolvedValue({
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('claims a pre-registration invitation only after social identity matches its mailbox', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      verificationToken: { findUnique: vi.fn().mockResolvedValue(tokenRow()), updateMany },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-1', email: 'invitee@example.com', userKey: 'invitee@example.com',
        }),
      },
    } as unknown as PrismaClient;

    await acceptTeamInviteSocialContinuation({
      tokenHash: 'a'.repeat(64),
      configUrl: 'https://client.example.com/auth-config',
      config,
      userId: 'user-1',
      prisma: prisma as never,
      now,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'token-1', usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, userId: 'user-1' },
    });
    expect(acceptTeamInviteWithinTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamInviteId: 'invite-1', userId: 'user-1' }),
    );
  });

  it('rejects a social identity for a different mailbox before claiming the invite', async () => {
    const updateMany = vi.fn();
    const prisma = {
      verificationToken: { findUnique: vi.fn().mockResolvedValue(tokenRow()), updateMany },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-1', email: 'other@example.com', userKey: 'other@example.com',
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      acceptTeamInviteSocialContinuation({
        tokenHash: 'a'.repeat(64),
        configUrl: 'https://client.example.com/auth-config',
        config,
        userId: 'user-1',
        prisma: prisma as never,
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(updateMany).not.toHaveBeenCalled();
    expect(acceptTeamInviteWithinTransactionMock).not.toHaveBeenCalled();
  });
});
