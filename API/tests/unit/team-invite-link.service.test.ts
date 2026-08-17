import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  createTeamInviteLink,
  listTeamInviteLinks,
  redeemTeamInviteLink,
  revokeTeamInviteLink,
} from '../../src/services/team-invite-link.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const NOW = new Date('2026-07-07T00:00:00.000Z');
const SHARED_SECRET = 'test-shared-secret-with-enough-length';

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

function makeOrgRow(overrides?: Record<string, unknown>) {
  return {
    id: 'org-1',
    domain: 'client.example.com',
    name: 'Acme',
    slug: 'acme',
    ownerId: 'owner-1',
    memberInvites: 'allowed',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePrisma() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    organisation: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
    teamMember: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    orgMember: { findFirst: vi.fn(), create: vi.fn() },
    teamInviteLink: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaClient;
}

describe('team-invite-link.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every call in this file passes deps.prisma explicitly, so this never touches a real
    // database — assertDatabaseEnabled just needs to see a DATABASE_URL is configured.
    process.env.DATABASE_URL = 'postgres://uoa-team-invite-link-tests.invalid/db';
  });

  describe('createTeamInviteLink', () => {
    it('rejects creation for a HIDDEN team', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'HIDDEN' });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        userId: 'actor-1',
        role: 'owner',
      });

      await expect(
        createTeamInviteLink(
          {
            orgId: 'org-1',
            teamId: 'team-1',
            domain: 'client.example.com',
            actorUserId: 'actor-1',
            config: makeConfig(),
          },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects a non-owner/admin (or deactivated) actor', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'INVITE_ONLY' });
      // getOrganisationMember({activeOnly:true}) finds nothing — a deactivated admin or a plain
      // member both surface identically here (design §4.9: activeOnly is the actor gate).
      prisma.orgMember.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'om-1', orgId: 'org-1', status: 'ACTIVE' });
      prisma.teamMember.findFirst.mockResolvedValue(null);

      await expect(
        createTeamInviteLink(
          {
            orgId: 'org-1',
            teamId: 'team-1',
            domain: 'client.example.com',
            actorUserId: 'actor-1',
            config: makeConfig(),
          },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects roleToAssign "owner"', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'INVITE_ONLY' });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        userId: 'actor-1',
        role: 'owner',
      });

      await expect(
        createTeamInviteLink(
          {
            orgId: 'org-1',
            teamId: 'team-1',
            domain: 'client.example.com',
            actorUserId: 'actor-1',
            roleToAssign: 'owner',
            config: makeConfig(),
          },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('caps maxUses at 400 and expiry at 30 days, returns the token once, stores only the hash', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'INVITE_ONLY' });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        userId: 'actor-1',
        role: 'owner',
      });
      (prisma.teamInviteLink.create as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'link-1',
          roleToAssign: data.roleToAssign,
          expiresAt: data.expiresAt,
          maxUses: data.maxUses,
          useCount: 0,
          revokedAt: null,
          createdAt: NOW,
        }),
      );

      const result = await createTeamInviteLink(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'client.example.com',
          actorUserId: 'actor-1',
          roleToAssign: 'admin',
          maxUses: 999_999,
          expiresInDays: 9999,
          config: makeConfig(),
        },
        {
          prisma,
          now: () => NOW,
          sharedSecret: SHARED_SECRET,
          generateToken: () => 'plaintext-token-value',
        },
      );

      expect(result.token).toBe('plaintext-token-value');
      expect(result.link.maxUses).toBe(400);
      expect(result.link.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(result.link.roleToAssign).toBe('admin');

      const createArgs = (prisma.teamInviteLink.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { data: Record<string, unknown> };
      expect(createArgs.data.tokenHash).toBeTypeOf('string');
      expect(createArgs.data.tokenHash).not.toBe('plaintext-token-value');
      expect(createArgs.data.token).toBeUndefined();
    });
  });

  describe('listTeamInviteLinks / revokeTeamInviteLink', () => {
    it('lists links without ever including the token', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        userId: 'actor-1',
        role: 'admin',
      });
      prisma.teamInviteLink.findMany.mockResolvedValue([
        {
          id: 'link-1',
          roleToAssign: 'member',
          expiresAt: NOW,
          maxUses: 400,
          useCount: 1,
          revokedAt: null,
          createdAt: NOW,
        },
      ]);

      const result = await listTeamInviteLinks(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'client.example.com',
          actorUserId: 'actor-1',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).not.toHaveProperty('token');
      expect(result.data[0]).not.toHaveProperty('tokenHash');
    });

    it('revokes a link (idempotent) and a revoked link no longer redeems', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({
        id: 'team-1',
        orgId: 'org-1',
        joinPolicy: 'INVITE_ONLY',
        org: { domain: 'client.example.com' },
      });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        userId: 'actor-1',
        role: 'owner',
      });
      prisma.teamInviteLink.findFirst.mockResolvedValue({ id: 'link-1', revokedAt: null });

      const result = await revokeTeamInviteLink(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          linkId: 'link-1',
          domain: 'client.example.com',
          actorUserId: 'actor-1',
          config: makeConfig(),
        },
        { prisma, now: () => NOW },
      );

      expect(result).toEqual({ revoked: true });
      expect(prisma.teamInviteLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'link-1' }, data: { revokedAt: NOW } }),
      );

      // A revoked link fails redemption with the generic error.
      prisma.teamInviteLink.findUnique.mockResolvedValue({
        id: 'link-1',
        orgId: 'org-1',
        teamId: 'team-1',
        roleToAssign: 'member',
        maxUses: 400,
        useCount: 1,
        revokedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 1000),
      });

      await expect(
        redeemTeamInviteLink(
          { token: 'some-token', userId: 'user-1', domain: 'client.example.com', config: makeConfig() },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(prisma.teamInviteLink.updateMany).not.toHaveBeenCalled();
    });
  });
});
