import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.acceptance.js';
import { toInviteRecord } from '../../src/services/team-invite.service.base.js';
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
  } as unknown as Prisma.TransactionClient;
}

describe('team invite lifecycle services', () => {
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

    it('rejects accepting an expired invite with a generic error', async () => {
      const tx = makeAcceptanceTx();
      tx.teamInvite.findUnique.mockResolvedValue({
        id: 'invite-1',
        orgId: 'org-1',
        teamId: 'team-1',
        email: 'invited@example.com',
        inviteName: null,
        teamRole: 'member',
        acceptedUserId: null,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        approvalStatus: 'NOT_REQUIRED',
        org: { id: 'org-1', domain: 'client.example.com' },
      });

      await expect(
        acceptTeamInviteWithinTransaction({
          prisma: tx,
          teamInviteId: 'invite-1',
          userId: 'user-1',
          config: makeConfig(),
          now: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

      expect(tx.orgMember.create).not.toHaveBeenCalled();
      expect(tx.teamMember.create).not.toHaveBeenCalled();
    });

    it('rejects accepting a PENDING (unapproved member-invite) invite with a generic error', async () => {
      const tx = makeAcceptanceTx();
      tx.teamInvite.findUnique.mockResolvedValue({
        id: 'invite-1',
        orgId: 'org-1',
        teamId: 'team-1',
        email: 'invited@example.com',
        inviteName: null,
        teamRole: 'member',
        acceptedUserId: null,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: null,
        approvalStatus: 'PENDING',
        org: { id: 'org-1', domain: 'client.example.com' },
      });

      await expect(
        acceptTeamInviteWithinTransaction({
          prisma: tx,
          teamInviteId: 'invite-1',
          userId: 'user-1',
          config: makeConfig(),
          now: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

      expect(tx.orgMember.create).not.toHaveBeenCalled();
    });
  });
});
