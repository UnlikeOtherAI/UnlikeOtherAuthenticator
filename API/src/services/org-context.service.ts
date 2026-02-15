import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { assertDatabaseEnabled, normalizeDomain } from './organisation.service.base.js';

type OrgContextPrisma = PrismaClient;

type OrgContextDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: OrgContextPrisma;
};

export type OrgContext = {
  org_id: string;
  org_role: string;
  teams: string[];
  team_roles: Record<string, string>;
  groups?: string[];
  group_admin?: string[];
};

function ensureFeatureEnabled(config: ClientConfig): void {
  if (!config.org_features?.enabled) {
    throw new AppError('NOT_FOUND', 404);
  }
}

export async function getUserOrgContext(
  params: {
    userId: string;
    domain: string;
    config: ClientConfig;
  },
  deps?: OrgContextDeps,
): Promise<OrgContext | null> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  ensureFeatureEnabled(params.config);

  const userId = params.userId.trim();
  const domain = normalizeDomain(params.domain);
  if (!userId || !domain) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgContextPrisma);

  const orgMembership = await prisma.orgMember.findFirst({
    where: {
      userId,
      org: {
        domain,
      },
    },
    select: {
      orgId: true,
      role: true,
    },
  });

  if (!orgMembership) return null;

  const teamMemberships = await prisma.teamMember.findMany({
    where: {
      userId,
      team: {
        orgId: orgMembership.orgId,
      },
    },
    orderBy: { teamId: 'asc' },
    select: {
      teamId: true,
      teamRole: true,
    },
  });

  const teamRoles: Record<string, string> = {};
  const teams = teamMemberships.map((row) => {
    teamRoles[row.teamId] = row.teamRole;
    return row.teamId;
  });

  const context: OrgContext = {
    org_id: orgMembership.orgId,
    org_role: orgMembership.role,
    teams,
    team_roles: teamRoles,
  };

  if (!params.config.org_features?.groups_enabled) {
    return context;
  }

  const groupMemberships = await prisma.groupMember.findMany({
    where: {
      userId,
      group: {
        orgId: orgMembership.orgId,
      },
    },
    orderBy: { groupId: 'asc' },
    select: {
      groupId: true,
      isAdmin: true,
    },
  });

  const groups = groupMemberships.map((row) => row.groupId);
  const groupAdmins = groupMemberships.filter((row) => row.isAdmin).map((row) => row.groupId);

  if (groups.length > 0) {
    context.groups = groups;
  }
  if (groupAdmins.length > 0) {
    context.group_admin = groupAdmins;
  }

  return context;
}
