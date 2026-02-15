import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { getUserOrgContext } from '../../src/services/org-context.service.js';

function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
  return {
    org_features: {
      enabled: true,
      groups_enabled: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
      ...overrides,
    },
  } as unknown as ClientConfig;
}

function makePrismaMock() {
  const prisma = {
    orgMember: {
      findFirst: vi.fn(),
    },
    teamMember: {
      findMany: vi.fn(),
    },
    groupMember: {
      findMany: vi.fn(),
    },
  } as unknown as PrismaClient;

  return prisma;
}

describe('org-context service', () => {
  const env = { DATABASE_URL: 'postgres://localhost:5432/authenticator_test' } as ReturnType<
    typeof getEnv
  >;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full org context including teams and groups when groups are enabled', async () => {
    const prisma = makePrismaMock();
    prisma.orgMember.findFirst.mockResolvedValue({
      orgId: 'org_1',
      role: 'admin',
    });
    prisma.teamMember.findMany.mockResolvedValue([
      { teamId: 'team_1', teamRole: 'lead' },
      { teamId: 'team_2', teamRole: 'member' },
    ]);
    prisma.groupMember.findMany.mockResolvedValue([
      { groupId: 'group_1', isAdmin: true },
      { groupId: 'group_2', isAdmin: false },
    ]);

    const context = await getUserOrgContext(
      {
        userId: 'user_1',
        domain: 'Acme.Example.com',
        config: makeConfig(),
      },
      { env, prisma },
    );

    expect(context).toMatchObject({
      org_id: 'org_1',
      org_role: 'admin',
      teams: ['team_1', 'team_2'],
      team_roles: {
        team_1: 'lead',
        team_2: 'member',
      },
      groups: ['group_1', 'group_2'],
      group_admin: ['group_1'],
    });
  });

  it('omits group fields when groups_enabled is false', async () => {
    const prisma = makePrismaMock();
    prisma.orgMember.findFirst.mockResolvedValue({
      orgId: 'org_1',
      role: 'member',
    });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'team_1', teamRole: 'lead' }]);

    const context = await getUserOrgContext(
      {
        userId: 'user_1',
        domain: 'acme.example.com',
        config: makeConfig({ groups_enabled: false }),
      },
      { env, prisma },
    );

    expect(context).toMatchObject({
      org_id: 'org_1',
      org_role: 'member',
      teams: ['team_1'],
      team_roles: { team_1: 'lead' },
    });
    expect(context).not.toHaveProperty('groups');
    expect(context).not.toHaveProperty('group_admin');
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it('returns null when user has no org membership for the domain', async () => {
    const prisma = makePrismaMock();
    prisma.orgMember.findFirst.mockResolvedValue(null);

    const context = await getUserOrgContext(
      {
        userId: 'user_1',
        domain: 'acme.example.com',
        config: makeConfig(),
      },
      { env, prisma },
    );

    expect(context).toBeNull();
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });
});
