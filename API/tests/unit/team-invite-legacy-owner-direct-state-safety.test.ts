import { describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  acceptTeamInviteWithinTransaction,
  declineTeamInviteForUser,
} from '../../src/services/team-invite.service.acceptance.js';
import { declineTeamInviteByToken } from '../../src/services/team-invite.service.token.js';
import { testUiTheme } from '../helpers/test-config.js';

/**
 * A2.1a legacy-owner direct-state safety: the contract-alignment cleanup can
 * leave rows behind that the normal create/resend paths can no longer see
 * (owner role is not invitable, DENIED approval is terminal). The direct
 * state-transition entry points — accept, authenticated-chooser decline, and
 * email-token decline — must reject those rows generically BEFORE any
 * `teamInvite.update` or membership write, while normal member/admin invites
 * keep working and a normally declined invite stays terminal.
 */

const NOW = new Date('2026-08-14T00:00:00.000Z');
const CONFIG_URL = 'https://client.example.com/auth-config';

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

// The unsafe legacy row: grants `owner` (never invitable) and is stamped
// DENIED (terminal). Neither direct accept nor either decline path may act on it.
const LEGACY_OWNER_DENIED_ROW = {
  id: 'invite-legacy-owner',
  orgId: 'org-1',
  teamId: 'team-1',
  email: 'legacy-owner@example.com',
  inviteName: 'Legacy Owner',
  teamRole: 'owner',
  acceptedUserId: null,
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  expiresAt: new Date('2026-12-31T00:00:00.000Z'),
  approvalStatus: 'DENIED',
  org: { id: 'org-1', domain: 'client.example.com' },
};

function makeAcceptanceTx() {
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
  } as unknown as Prisma.TransactionClient & {
    teamInvite: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    user: { findUnique: ReturnType<typeof vi.fn> };
    orgMember: { create: ReturnType<typeof vi.fn> };
    teamMember: { create: ReturnType<typeof vi.fn> };
  };
}

function makeInviteTokenTx(inviteRow: Record<string, unknown>) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    verificationToken: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'token-row-1',
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        configUrl: CONFIG_URL,
        userId: null,
        userKey: 'legacy-owner@example.com',
        tokenVersion: null,
        teamInviteId: (inviteRow as { id: string }).id,
        expiresAt: new Date('2026-08-14T00:10:00.000Z'),
        usedAt: null,
        teamInvite: {
          ...inviteRow,
          team: { name: 'Core Team' },
          org: { name: 'Acme' },
        },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    teamInvite: {
      update: vi.fn().mockResolvedValue({ id: (inviteRow as { id: string }).id }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(async (callback: (value: PrismaClient) => Promise<unknown>) =>
      callback(tx as unknown as PrismaClient),
    ),
  } as unknown as PrismaClient & {
    teamInvite: { update: ReturnType<typeof vi.fn> };
    verificationToken: { updateMany: ReturnType<typeof vi.fn> };
  };
  return tx;
}

const tokenDeps = (prisma: PrismaClient) => ({
  env: makeEnv(),
  prisma,
  sharedSecret: 'test-shared-secret-with-enough-length',
  now: () => NOW,
});

describe('legacy owner + DENIED invite direct-state safety', () => {
  it('rejects accept generically before any teamInvite update or membership write', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue(LEGACY_OWNER_DENIED_ROW);

    await expect(
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: 'invite-legacy-owner',
        userId: 'user-1',
        config: makeConfig(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.teamInvite.update).not.toHaveBeenCalled();
    expect(tx.orgMember.create).not.toHaveBeenCalled();
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });

  it('rejects accept of a legacy owner invite even with a benign approval stamp', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      ...LEGACY_OWNER_DENIED_ROW,
      approvalStatus: 'NOT_REQUIRED',
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'legacy-owner@example.com',
      name: 'Legacy Owner',
    });

    await expect(
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: 'invite-legacy-owner',
        userId: 'user-1',
        config: makeConfig(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.teamInvite.update).not.toHaveBeenCalled();
    expect(tx.orgMember.create).not.toHaveBeenCalled();
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });

  it('rejects authenticated chooser decline of the same unsafe row before update', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue(LEGACY_OWNER_DENIED_ROW);
    tx.user.findUnique.mockResolvedValue({ email: 'legacy-owner@example.com' });

    await expect(
      declineTeamInviteForUser({
        prisma: tx,
        teamInviteId: 'invite-legacy-owner',
        userId: 'user-1',
        config: makeConfig(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.teamInvite.update).not.toHaveBeenCalled();
  });

  it('rejects chooser decline of a legacy owner invite even with a benign approval stamp', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      ...LEGACY_OWNER_DENIED_ROW,
      approvalStatus: 'NOT_REQUIRED',
    });
    tx.user.findUnique.mockResolvedValue({ email: 'legacy-owner@example.com' });

    await expect(
      declineTeamInviteForUser({
        prisma: tx,
        teamInviteId: 'invite-legacy-owner',
        userId: 'user-1',
        config: makeConfig(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.teamInvite.update).not.toHaveBeenCalled();
  });

  it('rejects email-token decline of the same unsafe row before update', async () => {
    const prisma = makeInviteTokenTx(LEGACY_OWNER_DENIED_ROW);

    await expect(
      declineTeamInviteByToken(
        { token: 'token-123', configUrl: CONFIG_URL, config: makeConfig() },
        tokenDeps(prisma),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects email-token decline of a legacy owner invite even with a benign approval stamp', async () => {
    const prisma = makeInviteTokenTx({
      ...LEGACY_OWNER_DENIED_ROW,
      approvalStatus: 'NOT_REQUIRED',
    });

    await expect(
      declineTeamInviteByToken(
        { token: 'token-123', configUrl: CONFIG_URL, config: makeConfig() },
        tokenDeps(prisma),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });
});

describe('normal invite decline and terminal decline state', () => {
  it.each(['member', 'admin'])(
    'lets a normal %s invite decline through the chooser and performs its update',
    async (teamRole) => {
      const tx = makeAcceptanceTx();
      tx.teamInvite.findUnique.mockResolvedValue({
        ...LEGACY_OWNER_DENIED_ROW,
        id: 'invite-1',
        email: 'invited@example.com',
        teamRole,
        approvalStatus: 'APPROVED',
      });
      tx.user.findUnique.mockResolvedValue({ email: 'invited@example.com' });
      tx.teamInvite.update.mockResolvedValue({ id: 'invite-1' });

      await declineTeamInviteForUser({
        prisma: tx,
        teamInviteId: 'invite-1',
        userId: 'user-1',
        config: makeConfig(),
        now: NOW,
      });

      expect(tx.teamInvite.update).toHaveBeenCalledWith({
        where: { id: 'invite-1' },
        data: { declinedAt: NOW },
        select: { id: true },
      });
    },
  );

  it('lets a normal member invite decline by email token and performs its update', async () => {
    const prisma = makeInviteTokenTx({
      ...LEGACY_OWNER_DENIED_ROW,
      id: 'invite-1',
      email: 'invited@example.com',
      teamRole: 'member',
      approvalStatus: 'APPROVED',
    });

    await declineTeamInviteByToken(
      { token: 'token-123', configUrl: CONFIG_URL, config: makeConfig() },
      tokenDeps(prisma),
    );

    expect(prisma.teamInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: { declinedAt: NOW },
      select: { id: true },
    });
  });

  it('a normally declined invite cannot later be accepted', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      ...LEGACY_OWNER_DENIED_ROW,
      id: 'invite-1',
      email: 'invited@example.com',
      teamRole: 'member',
      approvalStatus: 'APPROVED',
      declinedAt: new Date('2026-08-13T00:00:00.000Z'),
    });

    await expect(
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: 'invite-1',
        userId: 'user-1',
        config: makeConfig(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.teamInvite.update).not.toHaveBeenCalled();
    expect(tx.orgMember.create).not.toHaveBeenCalled();
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });
});
