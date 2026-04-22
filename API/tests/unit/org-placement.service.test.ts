import { describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { placeUserInConfiguredOrganisation } from '../../src/services/org-placement.service.js';
import { testUiTheme } from '../helpers/test-config.js';

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

describe('org-placement.service', () => {
  it('places a new user in mapped org and team when email domain matches', async () => {
    const txOrgMemberFindFirst = vi.fn(async () => null);
    const txOrgMemberCreate = vi.fn(async () => ({ id: 'org-member-1' }));
    const txTeamMemberCreate = vi.fn(async () => ({ id: 'team-member-1' }));

    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => ({ id: 'org-1', domain: 'client.example.com' })),
      },
      team: {
        findFirst: vi.fn(async () => ({ id: 'team-1' })),
      },
      orgMember: {
        findFirst: vi.fn(async () => null),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return await fn({
          orgMember: {
            findFirst: txOrgMemberFindFirst,
            create: txOrgMemberCreate,
          },
          teamMember: {
            create: txTeamMemberCreate,
          },
        });
      }),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@company.com',
        config: makeConfig({
          registration_domain_mapping: [
            { email_domain: 'company.com', org_id: 'org-1', team_id: 'team-1' },
          ],
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'placed', orgId: 'org-1', teamId: 'team-1' });
    expect(prisma.organisation.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.team.findFirst).toHaveBeenCalledWith({
      where: { id: 'team-1', orgId: 'org-1' },
      select: { id: true },
    });
    expect(txOrgMemberCreate).toHaveBeenCalledWith({
      data: { orgId: 'org-1', userId: 'user-1', role: 'member' },
    });
    expect(txTeamMemberCreate).toHaveBeenCalledWith({
      data: { teamId: 'team-1', userId: 'user-1', teamRole: 'member' },
    });
  });

  it('uses the default team when mapping omits team_id', async () => {
    const txOrgMemberFindFirst = vi.fn(async () => null);
    const txOrgMemberCreate = vi.fn(async () => ({ id: 'org-member-1' }));
    const txTeamMemberCreate = vi.fn(async () => ({ id: 'team-member-1' }));

    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => ({ id: 'org-1', domain: 'client.example.com' })),
      },
      team: {
        findFirst: vi.fn(async () => ({ id: 'default-team' })),
      },
      orgMember: {
        findFirst: vi.fn(async () => null),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return await fn({
          orgMember: {
            findFirst: txOrgMemberFindFirst,
            create: txOrgMemberCreate,
          },
          teamMember: {
            create: txTeamMemberCreate,
          },
        });
      }),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@company.com',
        config: makeConfig({
          registration_domain_mapping: [{ email_domain: 'company.com', org_id: 'org-1' }],
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'placed', orgId: 'org-1', teamId: 'default-team' });
    expect(prisma.team.findFirst).toHaveBeenCalledWith({
      where: { orgId: 'org-1', isDefault: true },
      select: { id: true },
    });
    expect(txTeamMemberCreate).toHaveBeenCalledWith({
      data: { teamId: 'default-team', userId: 'user-1', teamRole: 'member' },
    });
  });

  it('skips placement when mapped org does not exist', async () => {
    const logError = vi.fn();
    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => null),
      },
      team: {
        findFirst: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@company.com',
        config: makeConfig({
          registration_domain_mapping: [{ email_domain: 'company.com', org_id: 'org-1' }],
        }),
      },
      { prisma, logError },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'org_not_found' });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips placement when mapped org belongs to another domain', async () => {
    const logError = vi.fn();
    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => ({ id: 'org-1', domain: 'other.example.com' })),
      },
      team: {
        findFirst: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@company.com',
        config: makeConfig({
          registration_domain_mapping: [{ email_domain: 'company.com', org_id: 'org-1' }],
        }),
      },
      { prisma, logError },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'org_domain_mismatch' });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips placement when user is already a member on this domain', async () => {
    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => ({ id: 'org-1', domain: 'client.example.com' })),
      },
      team: {
        findFirst: vi.fn(async () => ({ id: 'team-1' })),
      },
      orgMember: {
        findFirst: vi.fn(async () => ({ id: 'existing-member' })),
      },
      $transaction: vi.fn(),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@company.com',
        config: makeConfig({
          registration_domain_mapping: [{ email_domain: 'company.com', org_id: 'org-1', team_id: 'team-1' }],
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'already_member_for_domain' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls back org membership when team membership create fails in the transaction', async () => {
    type OrgMemberRow = { id: string; userId: string };
    const committed = {
      orgMembers: [] as OrgMemberRow[],
      teamMembers: [] as { id: string; userId: string }[],
    };

    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => ({ id: 'org-1', domain: 'client.example.com' })),
      },
      team: {
        findFirst: vi.fn(async () => ({ id: 'team-1' })),
      },
      orgMember: {
        findFirst: vi.fn(async () => committed.orgMembers[0] ?? null),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const draft = {
          orgMembers: [...committed.orgMembers],
          teamMembers: [...committed.teamMembers],
        };

        const tx = {
          orgMember: {
            findFirst: vi.fn(async () => draft.orgMembers[0] ?? null),
            create: vi.fn(async (args: { data: { userId: string } }) => {
              draft.orgMembers.push({ id: 'org-member-1', userId: args.data.userId });
              return { id: 'org-member-1' };
            }),
          },
          teamMember: {
            create: vi.fn(async () => {
              throw new Error('simulated team insert failure');
            }),
          },
        };

        const result = await fn(tx);
        committed.orgMembers = draft.orgMembers;
        committed.teamMembers = draft.teamMembers;
        return result;
      }),
    };

    const logError = vi.fn();
    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@company.com',
        config: makeConfig({
          registration_domain_mapping: [{ email_domain: 'company.com', org_id: 'org-1', team_id: 'team-1' }],
        }),
      },
      { prisma, logError },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'transaction_failed' });
    expect(committed.orgMembers).toHaveLength(0);
    expect(committed.teamMembers).toHaveLength(0);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('skips with no_placement_configured when no mapping matches and auto-create is disabled', async () => {
    const prisma = {
      organisation: {
        findUnique: vi.fn(),
        create: vi.fn(),
        findFirst: vi.fn(),
      },
      team: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      teamMember: {
        create: vi.fn(),
      },
      teamInvite: {
        findFirst: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'new.user@unmapped.com',
        config: makeConfig({
          registration_domain_mapping: [
            { email_domain: 'other.com', org_id: 'org-1', team_id: 'team-1' },
          ],
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'no_placement_configured' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.teamInvite.findFirst).not.toHaveBeenCalled();
  });

  it('auto-creates a personal org when no mapping matches and auto_create_personal_org_on_first_login is true', async () => {
    const txOrgMemberFindFirst = vi.fn(async () => null);
    const txOrgCreate = vi.fn(async () => ({ id: 'org-new' }));
    const txTeamCreate = vi.fn(async () => ({ id: 'team-new' }));
    const txOrgMemberCreate = vi.fn(async () => ({ id: 'org-member-1' }));
    const txTeamMemberCreate = vi.fn(async () => ({ id: 'team-member-1' }));
    const txOrgFindFirst = vi.fn(async () => null);
    const txTeamFindFirst = vi.fn(async () => null);

    const prisma = {
      organisation: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => null),
      },
      team: {
        findFirst: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      teamInvite: {
        findFirst: vi.fn(async () => null),
      },
      user: {
        findUnique: vi.fn(async () => ({ name: 'Jane' })),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return await fn({
          organisation: {
            findFirst: txOrgFindFirst,
            create: txOrgCreate,
          },
          team: {
            findFirst: txTeamFindFirst,
            create: txTeamCreate,
          },
          orgMember: {
            findFirst: txOrgMemberFindFirst,
            create: txOrgMemberCreate,
          },
          teamMember: {
            create: txTeamMemberCreate,
          },
        });
      }),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'jane@solo.com',
        config: makeConfig({
          org_features: { auto_create_personal_org_on_first_login: true },
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'auto_created', orgId: 'org-new', teamId: 'team-new' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { name: true },
    });
    expect(prisma.teamInvite.findFirst).toHaveBeenCalledTimes(1);
    expect(txOrgCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          domain: 'client.example.com',
          name: "Jane's organisation",
          ownerId: 'user-1',
        }),
      }),
    );
    expect(txTeamCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: 'org-new',
          name: 'General',
          isDefault: true,
        }),
      }),
    );
    expect(txOrgMemberCreate).toHaveBeenCalledWith({
      data: { orgId: 'org-new', userId: 'user-1', role: 'owner' },
    });
    expect(txTeamMemberCreate).toHaveBeenCalledWith({
      data: { teamId: 'team-new', userId: 'user-1', teamRole: 'member' },
    });
  });

  it('skips auto-create when pending_invites_block_auto_create is true and a pending invite exists', async () => {
    const prisma = {
      organisation: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      team: {
        findFirst: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      teamInvite: {
        findFirst: vi.fn(async () => ({ id: 'invite-1' })),
      },
      user: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'jane@solo.com',
        config: makeConfig({
          org_features: {
            auto_create_personal_org_on_first_login: true,
            pending_invites_block_auto_create: true,
          },
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'pending_invite_blocks_auto_create' });
    expect(prisma.teamInvite.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('auto-creates even with a pending invite when pending_invites_block_auto_create is false', async () => {
    const txOrgCreate = vi.fn(async () => ({ id: 'org-new' }));
    const txTeamCreate = vi.fn(async () => ({ id: 'team-new' }));

    const prisma = {
      organisation: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => null),
      },
      team: {
        findFirst: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      teamInvite: {
        findFirst: vi.fn(async () => ({ id: 'invite-1' })),
      },
      user: {
        findUnique: vi.fn(async () => ({ name: null })),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return await fn({
          organisation: {
            findFirst: vi.fn(async () => null),
            create: txOrgCreate,
          },
          team: {
            findFirst: vi.fn(async () => null),
            create: txTeamCreate,
          },
          orgMember: {
            findFirst: vi.fn(async () => null),
            create: vi.fn(async () => ({ id: 'org-member-1' })),
          },
          teamMember: {
            create: vi.fn(async () => ({ id: 'team-member-1' })),
          },
        });
      }),
    };

    const result = await placeUserInConfiguredOrganisation(
      {
        userId: 'user-1',
        email: 'jane@solo.com',
        config: makeConfig({
          org_features: {
            auto_create_personal_org_on_first_login: true,
            pending_invites_block_auto_create: false,
          },
        }),
      },
      { prisma },
    );

    expect(result).toEqual({ status: 'auto_created', orgId: 'org-new', teamId: 'team-new' });
    expect(prisma.teamInvite.findFirst).not.toHaveBeenCalled();
    expect(txOrgCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "jane's organisation",
        }),
      }),
    );
  });
});
