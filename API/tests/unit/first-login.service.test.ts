import { describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { buildFirstLoginBlock } from '../../src/services/first-login.service.js';
import { CLIENT_DOMAIN_TEAM_POLICY } from '../../src/services/product-team-policy.service.js';
import { testUiTheme } from '../helpers/test-config.js';

// The team row's updatedAt versions the public avatar URL (Docs/Auth/avatars.md §11.4).


function makeConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  const { org_features: orgFeaturesOverride, ...rest } = overrides ?? {};
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
    ...rest,
    org_features: {
      enabled: true,
      groups_enabled: false,
      user_needs_team: false,
      auto_create_personal_org_on_first_login: false,
      allow_user_create_org: false,
      pending_invites_block_auto_create: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
      ...(orgFeaturesOverride ?? {}),
    },
  };
}

describe('first-login.service', () => {
  it('returns null when org_features.enabled is false', async () => {
    const prisma = {
      user: { findUnique: vi.fn() },
      orgMember: { findMany: vi.fn() },
      team: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn() },
      teamInvite: { findMany: vi.fn() },
    };

    const result = await buildFirstLoginBlock(
      {
        userId: 'user-1',
        config: makeConfig({ org_features: { enabled: false } }),
      },
      { prisma },
    );

    expect(result).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the user cannot be found', async () => {
    const prisma = {
      user: { findUnique: vi.fn(async () => null) },
      orgMember: { findMany: vi.fn() },
      team: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn() },
      teamInvite: { findMany: vi.fn() },
    };

    const result = await buildFirstLoginBlock(
      { userId: 'user-1', config: makeConfig() },
      { prisma },
    );

    expect(result).toBeNull();
    expect(prisma.orgMember.findMany).not.toHaveBeenCalled();
  });

  it('returns empty memberships with can_create_org echoing config when user has no orgs/teams/invites', async () => {
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ email: 'jane@solo.com' })) },
      orgMember: { findMany: vi.fn(async () => []) },
      team: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn(async () => []) },
      teamInvite: { findMany: vi.fn(async () => []) },
    };

    const result = await buildFirstLoginBlock(
      {
        userId: 'user-1',
        config: makeConfig({ org_features: { allow_user_create_org: true } }),
      },
      { policy: CLIENT_DOMAIN_TEAM_POLICY, prisma },
    );

    expect(result).toEqual({
      memberships: { orgs: [], teams: [] },
      pending_invites: [],
      capabilities: { can_create_org: true, can_accept_invite: false },
    });
  });

  it('maps orgMember, teamMember, and pending invite rows and sets can_accept_invite', async () => {
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ email: 'jane@solo.com' })) },
      orgMember: {
        findMany: vi.fn(async () => [
          { orgId: 'org-1', role: 'owner' },
          { orgId: 'org-2', role: 'member' },
        ]),
      },
      team: { findMany: vi.fn(async () => []) }, teamMember: {
        findMany: vi.fn(async () => [
          { teamId: 'team-1', teamRole: 'member', team: { orgId: 'org-1' } },
        ]),
      },
      teamInvite: {
        findMany: vi.fn(async () => [
          {
            id: 'invite-1',
            orgId: 'org-3',
            teamId: 'team-3',
            team: { name: 'Engineers' },
          },
        ]),
      },
    };

    const result = await buildFirstLoginBlock(
      {
        userId: 'user-1',
        config: makeConfig({ org_features: { allow_user_create_org: false } }),
      },
      { policy: CLIENT_DOMAIN_TEAM_POLICY, prisma },
    );

    expect(result).toEqual({
      memberships: {
        orgs: [
          { orgId: 'org-1', role: 'owner' },
          { orgId: 'org-2', role: 'member' },
        ],
        teams: [{ teamId: 'team-1', orgId: 'org-1', role: 'member' }],
      },
      pending_invites: [
        {
          inviteId: 'invite-1',
          type: 'team',
          orgId: 'org-3',
          teamId: 'team-3',
          teamName: 'Engineers',
        },
      ],
      capabilities: { can_create_org: false, can_accept_invite: true },
    });

    expect(prisma.orgMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'ACTIVE', org: { domain: 'client.example.com' } },
      select: { orgId: true, role: true },
    });
    expect(prisma.teamInvite.findMany).toHaveBeenCalledWith({
      where: {
        email: 'jane@solo.com',
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        org: { domain: 'client.example.com' },
      },
      select: {
        id: true,
        orgId: true,
        teamId: true,
        team: { select: { name: true } },
      },
    });
  });

  it('includes selected cross-domain memberships in firstLogin for a bound product', async () => {
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ email: 'jane@acme.com' })) },
      orgMember: { findMany: vi.fn(async () => []) },
      team: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn(async () => []) },
      teamInvite: { findMany: vi.fn(async () => []) },
    };
    const crossProductPrisma = {
      user: { findUnique: vi.fn() },
      orgMember: {
        findMany: vi.fn(async () => [{ orgId: 'org-nessie', role: 'member' }]),
      },
      team: { findMany: vi.fn(async () => []) }, teamMember: {
        findMany: vi.fn(async () => [
          {
            teamId: 'team-nessie',
            teamRole: 'member',
            team: { orgId: 'org-nessie', iconUrl: null },
          },
        ]),
      },
      teamInvite: { findMany: vi.fn() },
    };

    const result = await buildFirstLoginBlock(
      {
        userId: 'user-1',
        config: makeConfig({ domain: 'api.deepsignal.live' }),
      },
      {
        crossProductPrisma,
        policy: {
          scope: 'all_active_memberships',
          serviceId: 'service-deepsignal',
          product: 'deepsignal',
        },
        prisma,
      },
    );

    expect(result?.memberships).toEqual({
      orgs: [{ orgId: 'org-nessie', role: 'member' }],
      teams: [
        {
          teamId: 'team-nessie',
          orgId: 'org-nessie',
          role: 'member',
          iconUrl: null,
        },
      ],
    });
    expect(crossProductPrisma.teamMember.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        status: 'ACTIVE',
        team: {
          org: {
            members: { some: { userId: 'user-1', status: 'ACTIVE' } },
          },
        },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { orgId: true, iconUrl: true } },
      },
    });
  });
});
