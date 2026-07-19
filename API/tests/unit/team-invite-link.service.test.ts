import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  assertTeamInviteLinkValidForLanding,
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
        { orgId: 'org-1', teamId: 'team-1', domain: 'client.example.com', actorUserId: 'actor-1' },
        { prisma },
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).not.toHaveProperty('token');
      expect(result.data[0]).not.toHaveProperty('tokenHash');
    });

    it('revokes a link (idempotent) and a revoked link no longer redeems', async () => {
      const prisma = makePrisma();
      prisma.organisation.findFirst.mockResolvedValue(makeOrgRow());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'INVITE_ONLY' });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        userId: 'actor-1',
        role: 'owner',
      });
      prisma.teamInviteLink.findFirst.mockResolvedValue({ id: 'link-1', revokedAt: null });

      const result = await revokeTeamInviteLink(
        { orgId: 'org-1', teamId: 'team-1', linkId: 'link-1', domain: 'client.example.com', actorUserId: 'actor-1' },
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

  describe('redeemTeamInviteLink', () => {
    function mockValidLink(overrides?: Record<string, unknown>) {
      return {
        id: 'link-1',
        orgId: 'org-1',
        teamId: 'team-1',
        roleToAssign: 'admin',
        maxUses: 400,
        useCount: 5,
        revokedAt: null,
        expiresAt: new Date(NOW.getTime() + 1000),
        ...overrides,
      };
    }

    it('joins the user as an ACTIVE team member with roleToAssign, incrementing useCount (reactivating a REMOVED row)', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(mockValidLink());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'INVITE_ONLY' });
      prisma.teamInviteLink.updateMany.mockResolvedValue({ count: 1 });
      prisma.orgMember.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'om-1', orgId: 'org-1', status: 'ACTIVE' });
      prisma.orgMember.create.mockResolvedValue({ id: 'om-1' });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-1', status: 'REMOVED' });
      prisma.teamMember.update.mockResolvedValue({ id: 'tm-1' });

      const result = await redeemTeamInviteLink(
        { token: 'plain-token', userId: 'user-1', domain: 'client.example.com', config: makeConfig() },
        { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
      );

      expect(result).toEqual({ teamId: 'team-1', orgId: 'org-1' });
      expect(prisma.teamInviteLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', revokedAt: null, expiresAt: { gt: NOW }, useCount: { lt: 400 } },
        data: { useCount: { increment: 1 } },
      });
      expect(prisma.orgMember.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { orgId: 'org-1', userId: 'user-1', role: 'member' } }),
      );
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { id: 'tm-1' },
        data: { status: 'ACTIVE', statusChangedAt: NOW, teamRole: 'admin' },
      });
    });

    it('is idempotent when the user is already an ACTIVE member — still returns the team', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(mockValidLink());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'INVITE_ONLY' });
      prisma.teamInviteLink.updateMany.mockResolvedValue({ count: 1 });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        status: 'ACTIVE',
      });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-1', status: 'ACTIVE' });

      const result = await redeemTeamInviteLink(
        { token: 'plain-token', userId: 'user-1', domain: 'client.example.com', config: makeConfig() },
        { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
      );

      expect(result).toEqual({ teamId: 'team-1', orgId: 'org-1' });
      expect(prisma.orgMember.create).not.toHaveBeenCalled();
      expect(prisma.teamMember.update).not.toHaveBeenCalled();
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown token', () => undefined],
      ['revoked', () => mockValidLink({ revokedAt: NOW })],
      ['expired', () => mockValidLink({ expiresAt: new Date(NOW.getTime() - 1000) })],
      ['over-cap', () => mockValidLink({ useCount: 400, maxUses: 400 })],
    ])('rejects %s with the same generic error', async (_label, buildLink) => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(buildLink() ?? null);
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'INVITE_ONLY' });

      await expect(
        redeemTeamInviteLink(
          { token: 'plain-token', userId: 'user-1', domain: 'client.example.com', config: makeConfig() },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(prisma.teamInviteLink.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a HIDDEN team with the generic error', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(mockValidLink());
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'HIDDEN' });

      await expect(
        redeemTeamInviteLink(
          { token: 'plain-token', userId: 'user-1', domain: 'client.example.com', config: makeConfig() },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects a cross-domain team with the generic error', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(mockValidLink());
      // Scoped lookup (`org: { domain }`) never matches a team on another domain.
      prisma.team.findFirst.mockResolvedValue(null);

      await expect(
        redeemTeamInviteLink(
          { token: 'plain-token', userId: 'user-1', domain: 'other.example.com', config: makeConfig() },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('the atomic updateMany guard prevents useCount from exceeding maxUses under a simulated race', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(mockValidLink({ useCount: 399, maxUses: 400 }));
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'INVITE_ONLY' });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'om-1',
        orgId: 'org-1',
        status: 'ACTIVE',
      });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-1', status: 'ACTIVE' });

      // First redemption wins the conditional update (still under cap in the DB).
      (prisma.teamInviteLink.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });
      const first = await redeemTeamInviteLink(
        { token: 'plain-token', userId: 'user-1', domain: 'client.example.com', config: makeConfig() },
        { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
      );
      expect(first).toEqual({ teamId: 'team-1', orgId: 'org-1' });

      // Second concurrent redemption loses the race — the WHERE clause no longer matches (useCount
      // already at maxUses in the real DB), simulated here by the conditional update returning 0.
      (prisma.teamInviteLink.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
      await expect(
        redeemTeamInviteLink(
          { token: 'plain-token', userId: 'user-2', domain: 'client.example.com', config: makeConfig() },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('assertTeamInviteLinkValidForLanding', () => {
    it('resolves for a valid, non-redeemed token without mutating anything', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue({
        id: 'link-1',
        orgId: 'org-1',
        teamId: 'team-1',
        roleToAssign: 'member',
        maxUses: 400,
        useCount: 0,
        revokedAt: null,
        expiresAt: new Date(NOW.getTime() + 1000),
      });
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1', joinPolicy: 'INVITE_ONLY' });

      await expect(
        assertTeamInviteLinkValidForLanding(
          { token: 'plain-token', domain: 'client.example.com' },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).resolves.toBeUndefined();
      expect(prisma.teamInviteLink.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid token with the generic error', async () => {
      const prisma = makePrisma();
      prisma.teamInviteLink.findUnique.mockResolvedValue(null);

      await expect(
        assertTeamInviteLinkValidForLanding(
          { token: 'bad-token', domain: 'client.example.com' },
          { prisma, now: () => NOW, sharedSecret: SHARED_SECRET },
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
