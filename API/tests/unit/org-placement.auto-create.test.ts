import { describe, expect, it, vi } from 'vitest';
import { placeUserInConfiguredOrganisation } from '../../src/services/org-placement.service.js';
import { makeConfig } from './helpers/org-placement-config.js';

describe('personal organisation placement', () => {
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
      where: { id: 'user-1', lifecycleStatus: 'ACTIVE' },
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
          name: "Jane's organisation",
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
