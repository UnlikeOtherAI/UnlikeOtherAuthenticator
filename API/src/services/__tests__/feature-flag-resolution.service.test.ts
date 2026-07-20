import { MembershipStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { getResolvedAppFeatureFlags } from '../feature-flag-resolution.service.js';

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app_water',
    orgId: 'org_1',
    domains: ['app.deepwater.example'],
    active: true,
    featureFlagsEnabled: true,
    roleFlagMatrixEnabled: true,
    ...overrides,
  };
}

function prisma(
  overrides: {
    app?: unknown;
    definitions?: unknown[];
    orgMembership?: unknown;
    teamMemberships?: unknown[];
    roleValues?: unknown[];
    userOverrides?: unknown[];
  } = {},
) {
  const appFindUnique = vi
    .fn()
    .mockResolvedValue(Object.hasOwn(overrides, 'app') ? overrides.app : app());
  const definitionFindMany = vi.fn().mockResolvedValue(
    overrides.definitions ?? [
      { key: 'can_be_private', defaultState: false },
      { key: 'show_beta', defaultState: true },
    ],
  );
  const orgMemberFindUnique = vi.fn().mockResolvedValue(
    overrides.orgMembership ?? {
      role: 'member',
      status: MembershipStatus.ACTIVE,
    },
  );
  const teamMemberFindMany = vi.fn().mockResolvedValue(
    overrides.teamMemberships ?? [
      {
        teamId: 'team_1',
        teamRole: 'admin',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
  );
  const roleValueFindMany = vi
    .fn()
    .mockResolvedValue(overrides.roleValues ?? [{ flagKey: 'can_be_private', value: true }]);
  const overrideFindMany = vi
    .fn()
    .mockResolvedValue(overrides.userOverrides ?? [{ flagKey: 'show_beta', value: false }]);
  return {
    appFindUnique,
    definitionFindMany,
    orgMemberFindUnique,
    teamMemberFindMany,
    roleValueFindMany,
    overrideFindMany,
    client: {
      app: { findUnique: appFindUnique },
      featureFlagDefinition: { findMany: definitionFindMany },
      featureFlagRoleValue: { findMany: roleValueFindMany },
      featureFlagUserOverride: { findMany: overrideFindMany },
      orgMember: { findUnique: orgMemberFindUnique },
      teamMember: { findMany: teamMemberFindMany },
    } as never,
  };
}

describe('backend feature-flag resolution', () => {
  it('binds one app domain and exact active user/team before resolving override > role > default', async () => {
    const mocks = prisma();
    const flags = await getResolvedAppFeatureFlags(
      {
        appId: 'app_water',
        domain: 'App.DeepWater.Example',
        userId: 'user_1',
        teamId: 'team_1',
      },
      { prisma: mocks.client },
    );

    expect(flags).toEqual({
      can_be_private: true,
      show_beta: false,
    });
    expect(mocks.appFindUnique).toHaveBeenCalledWith({
      where: { id: 'app_water' },
      select: {
        id: true,
        orgId: true,
        domains: true,
        active: true,
        featureFlagsEnabled: true,
        roleFlagMatrixEnabled: true,
      },
    });
    expect(mocks.orgMemberFindUnique).toHaveBeenCalledWith({
      where: {
        orgId_userId: {
          orgId: 'org_1',
          userId: 'user_1',
        },
      },
      select: { role: true, status: true },
    });
    expect(mocks.teamMemberFindMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_1',
        status: MembershipStatus.ACTIVE,
        team: {
          orgId: 'org_1',
          id: 'team_1',
        },
      },
      select: {
        teamId: true,
        teamRole: true,
        createdAt: true,
      },
    });
    expect(mocks.roleValueFindMany).toHaveBeenCalledWith({
      where: {
        appId: 'app_water',
        roleName: 'admin',
        flagKey: { in: ['can_be_private', 'show_beta'] },
      },
      select: { flagKey: true, value: true },
    });
  });

  it.each([
    {
      name: 'unknown app id',
      input: {},
      overrides: { app: null },
    },
    {
      name: 'wrong app domain',
      input: { domain: 'other.example' },
      overrides: {},
    },
    {
      name: 'inactive app',
      input: {},
      overrides: { app: app({ active: false }) },
    },
    {
      name: 'disabled feature-flag service',
      input: {},
      overrides: { app: app({ featureFlagsEnabled: false }) },
    },
    {
      name: 'inactive organisation membership',
      input: {},
      overrides: {
        orgMembership: { role: 'member', status: MembershipStatus.DEACTIVATED },
      },
    },
    {
      name: 'missing exact team membership',
      input: {},
      overrides: { teamMemberships: [] },
    },
  ])('returns an empty, non-enumerating map for $name', async ({ input, overrides }) => {
    const mocks = prisma(overrides);
    const flags = await getResolvedAppFeatureFlags(
      {
        appId: 'app_water',
        domain: 'app.deepwater.example',
        userId: 'user_1',
        teamId: 'team_1',
        ...input,
      },
      { prisma: mocks.client },
    );

    expect(flags).toEqual({});
  });

  it('selects a stable active team when teamId is omitted', async () => {
    const mocks = prisma({
      orgMembership: {
        role: 'admin',
        status: MembershipStatus.ACTIVE,
      },
      teamMemberships: [
        {
          teamId: 'team_later',
          teamRole: 'owner',
          createdAt: new Date('2026-07-02T00:00:00.000Z'),
        },
        {
          teamId: 'team_earlier',
          teamRole: 'member',
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      roleValues: [],
      userOverrides: [],
    });

    await getResolvedAppFeatureFlags(
      {
        appId: 'app_water',
        domain: 'app.deepwater.example',
        userId: 'user_1',
      },
      { prisma: mocks.client },
    );

    expect(mocks.roleValueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roleName: 'owner' }),
      }),
    );
  });
});
