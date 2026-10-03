import { describe, expect, it, vi } from 'vitest';
import { placeUserInConfiguredOrganisation } from '../../src/services/org-placement.service.js';
import { makeConfig } from './helpers/org-placement-config.js';

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

  it('skips placement when user is already a member of the mapped organisation', async () => {
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

    expect(result).toEqual({ status: 'skipped', reason: 'already_member_for_organisation' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('places a user who belongs to another organisation on the same domain', async () => {
    const txOrgMemberFindFirst = vi.fn(async () => null);
    const prisma = {
      organisation: {
        findUnique: vi.fn(async () => ({ id: 'org-1', domain: 'client.example.com' })),
      },
      team: {
        findFirst: vi.fn(async () => ({ id: 'team-1' })),
      },
      orgMember: {
        findFirst: vi.fn(async (args: { where: { orgId: string } }) =>
          args.where.orgId === 'other-org' ? { id: 'existing-member' } : null,
        ),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        await fn({
          orgMember: {
            findFirst: txOrgMemberFindFirst,
            create: vi.fn(async () => ({ id: 'org-member-1' })),
          },
          teamMember: {
            create: vi.fn(async () => ({ id: 'team-member-1' })),
          },
        }),
      ),
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
    expect(prisma.orgMember.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', orgId: 'org-1' },
      select: { id: true },
    });
    expect(txOrgMemberFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', orgId: 'org-1' },
      select: { id: true },
    });
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

});
