import { MembershipStatus, type App, type PrismaClient } from '@prisma/client';

import { normalizeDomain } from '../utils/domain.js';

type FlagPrisma = Pick<
  PrismaClient,
  | 'app'
  | 'featureFlagDefinition'
  | 'featureFlagRoleValue'
  | 'featureFlagUserOverride'
  | 'orgMember'
  | 'teamMember'
>;

type FlagApp = Pick<
  App,
  'id' | 'orgId' | 'domains' | 'active' | 'featureFlagsEnabled' | 'roleFlagMatrixEnabled'
>;

export type FeatureFlagSubject = {
  userId?: string;
  teamId?: string;
};

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function appHasDomain(app: Pick<App, 'domains'>, domain: string): boolean {
  const normalizedDomain = normalizeDomain(domain);
  return jsonStringArray(app.domains)
    .map(normalizeDomain)
    .filter(Boolean)
    .includes(normalizedDomain);
}

function roleRank(role: string): number {
  if (role === 'owner') return 2;
  if (role === 'admin') return 1;
  return 0;
}

async function resolveRoleName(
  app: FlagApp,
  subject: Required<Pick<FeatureFlagSubject, 'userId'>> & Pick<FeatureFlagSubject, 'teamId'>,
  prisma: FlagPrisma,
): Promise<{ authorized: boolean; roleName: string | null }> {
  const orgMembership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId: app.orgId,
        userId: subject.userId,
      },
    },
    select: { role: true, status: true },
  });
  if (orgMembership?.status !== MembershipStatus.ACTIVE) {
    return { authorized: false, roleName: null };
  }

  const memberships = await prisma.teamMember.findMany({
    where: {
      userId: subject.userId,
      status: MembershipStatus.ACTIVE,
      team: {
        orgId: app.orgId,
        ...(subject.teamId ? { id: subject.teamId } : {}),
      },
    },
    select: {
      teamId: true,
      teamRole: true,
      createdAt: true,
    },
  });
  if (subject.teamId && memberships.length !== 1) {
    return { authorized: false, roleName: null };
  }
  if (memberships.length === 0) {
    return { authorized: true, roleName: null };
  }

  const orgRole = orgMembership.role;
  const selected = memberships.sort((left, right) => {
    const leftRole = roleRank(orgRole) > roleRank(left.teamRole) ? orgRole : left.teamRole;
    const rightRole = roleRank(orgRole) > roleRank(right.teamRole) ? orgRole : right.teamRole;
    const rank = roleRank(rightRole) - roleRank(leftRole);
    if (rank !== 0) return rank;
    const created = left.createdAt.getTime() - right.createdAt.getTime();
    if (created !== 0) return created;
    return left.teamId.localeCompare(right.teamId);
  })[0];
  if (!selected) {
    return { authorized: true, roleName: null };
  }
  const roleName = roleRank(orgRole) > roleRank(selected.teamRole) ? orgRole : selected.teamRole;
  return { authorized: true, roleName };
}

export async function resolveAppFeatureFlags(
  app: FlagApp,
  subject: FeatureFlagSubject,
  deps: { prisma: FlagPrisma },
  options: { unauthorizedSubject: 'empty' | 'defaults' } = {
    unauthorizedSubject: 'empty',
  },
): Promise<Record<string, boolean>> {
  if (!app.active || !app.featureFlagsEnabled) return {};

  const definitions = await deps.prisma.featureFlagDefinition.findMany({
    where: { appId: app.id },
    orderBy: { createdAt: 'asc' },
    select: { key: true, defaultState: true },
  });
  const flags = Object.fromEntries(
    definitions.map((definition) => [definition.key, definition.defaultState]),
  );
  if (!subject.userId || definitions.length === 0) return flags;

  const context = await resolveRoleName(
    app,
    { userId: subject.userId, teamId: subject.teamId },
    deps.prisma,
  );
  if (!context.authorized) {
    return options.unauthorizedSubject === 'defaults' ? flags : {};
  }

  if (app.roleFlagMatrixEnabled && context.roleName) {
    const roleValues = await deps.prisma.featureFlagRoleValue.findMany({
      where: {
        appId: app.id,
        roleName: context.roleName,
        flagKey: { in: definitions.map((definition) => definition.key) },
      },
      select: { flagKey: true, value: true },
    });
    for (const roleValue of roleValues) {
      flags[roleValue.flagKey] = roleValue.value;
    }
  }

  const overrides = await deps.prisma.featureFlagUserOverride.findMany({
    where: {
      appId: app.id,
      userId: subject.userId,
      flagKey: { in: definitions.map((definition) => definition.key) },
    },
    select: { flagKey: true, value: true },
  });
  for (const override of overrides) {
    flags[override.flagKey] = override.value;
  }
  return flags;
}

export async function getResolvedAppFeatureFlags(
  params: {
    appId: string;
    domain: string;
    userId: string;
    teamId?: string;
  },
  deps: { prisma: FlagPrisma },
): Promise<Record<string, boolean>> {
  const app = await deps.prisma.app.findUnique({
    where: { id: params.appId },
    select: {
      id: true,
      orgId: true,
      domains: true,
      active: true,
      featureFlagsEnabled: true,
      roleFlagMatrixEnabled: true,
    },
  });
  if (!app || !appHasDomain(app, params.domain)) return {};
  return resolveAppFeatureFlags(
    app,
    {
      userId: params.userId,
      teamId: params.teamId,
    },
    deps,
  );
}
