import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { assertDatabaseEnabled, normalizeDomain } from './organisation.service.base.js';
import {
  resolveProductWorkspacePolicy,
  type ProductWorkspacePolicyPrisma,
} from './product-workspace-policy.service.js';

type OrgContextPrisma = PrismaClient;

type OrgContextDeps = {
  crossProductPrisma?: OrgContextPrisma;
  env?: ReturnType<typeof getEnv>;
  policyPrisma?: ProductWorkspacePolicyPrisma;
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

export async function getActiveUserOrgContext(
  params: {
    userId: string;
    domain: string;
    /** Resolve one requested organisation instead of the first active membership. */
    orgId?: string;
    groupsEnabled?: boolean;
    /** Server-owned product policy only; callers must never derive this from browser input. */
    allowCrossDomain?: boolean;
  },
  deps?: OrgContextDeps,
): Promise<OrgContext | null> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const userId = params.userId.trim();
  const domain = normalizeDomain(params.domain);
  const orgId = params.orgId?.trim();
  if (!userId || !domain) throw new AppError('BAD_REQUEST', 400);
  if (params.orgId !== undefined && !orgId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgContextPrisma);

  // Lifecycle enforcement (design §4.1): only ACTIVE memberships appear in the token/context.
  // A DEACTIVATED or REMOVED membership disappears from claims within one access-token TTL because
  // org claims are re-resolved on every refresh — no separate revocation machinery needed.
  const orgMembership = await prisma.orgMember.findFirst({
    where: {
      userId,
      ...(orgId ? { orgId } : {}),
      status: 'ACTIVE',
      ...(params.allowCrossDomain ? {} : { org: { domain } }),
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
      status: 'ACTIVE',
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

  if (!params.groupsEnabled) {
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

/**
 * Resolve one exact active organisation for a client. Legacy same-domain scope
 * wins; only an unambiguous active product mapping may retry across domains.
 */
export async function getActiveClientOrgContext(
  params: {
    userId: string;
    domain: string;
    orgId: string;
    groupsEnabled?: boolean;
  },
  deps?: OrgContextDeps,
): Promise<OrgContext | null> {
  const sameDomain = await getActiveUserOrgContext(params, deps);
  if (sameDomain) return sameDomain;

  const policy = await resolveProductWorkspacePolicy(
    { domain: params.domain },
    {
      prisma: deps?.policyPrisma ?? (getAdminPrisma() as unknown as ProductWorkspacePolicyPrisma),
    },
  );
  if (policy.scope !== 'all_active_memberships') return null;

  const crossProductPrisma =
    deps?.crossProductPrisma ?? (getAdminPrisma() as unknown as OrgContextPrisma);
  return getActiveUserOrgContext(
    { ...params, allowCrossDomain: true },
    { ...deps, prisma: crossProductPrisma },
  );
}

export async function getUserOrgContext(
  params: {
    userId: string;
    domain: string;
    config: ClientConfig;
    /** Resolve one requested organisation instead of the first active membership. */
    orgId?: string;
  },
  deps?: OrgContextDeps,
): Promise<OrgContext | null> {
  ensureFeatureEnabled(params.config);
  return getActiveUserOrgContext(
    {
      userId: params.userId,
      domain: params.domain,
      orgId: params.orgId,
      groupsEnabled: params.config.org_features?.groups_enabled,
    },
    deps,
  );
}
