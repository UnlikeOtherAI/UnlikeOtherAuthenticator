import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  resolveProductTeamPolicy,
  type ProductTeamPolicyPrisma,
} from './product-team-policy.service.js';

type TeamScopePrisma = Pick<
  PrismaClient,
  'organisation' | 'orgMember' | 'team' | 'teamMember'
>;
type TeamLockPrisma = Pick<PrismaClient, '$queryRaw'>;

function rejectTeamScope(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

async function activeTeamScopeExists(
  params: {
    allowCrossDomain: boolean;
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: { prisma: TeamScopePrisma },
): Promise<boolean> {
  const orgId = params.orgId ?? undefined;
  const teamId = params.teamId ?? undefined;
  if (!orgId && !teamId) return true;
  if (!orgId || !teamId) return false;

  const [orgMember, teamMember] = await Promise.all([
    deps.prisma.orgMember.findFirst({
      where: {
        orgId,
        userId: params.userId,
        status: 'ACTIVE',
        ...(params.allowCrossDomain ? {} : { org: { domain: params.domain } }),
      },
      select: { id: true },
    }),
    deps.prisma.teamMember.findFirst({
      where: {
        teamId,
        userId: params.userId,
        status: 'ACTIVE',
        team: {
          orgId,
          ...(params.allowCrossDomain ? {} : { org: { domain: params.domain } }),
        },
      },
      select: { id: true },
    }),
  ]);

  return Boolean(orgMember && teamMember);
}

/** Lock a team container before a destructive operation reaches membership rows. */
export async function lockTeamOrganisationRow(
  orgId: string,
  deps: { prisma: TeamLockPrisma },
): Promise<boolean> {
  const rows = await deps.prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT o.id
      FROM "organisations" o
      WHERE o.id = ${orgId}
      FOR UPDATE OF o
    `,
  );
  return rows.length === 1;
}

/**
 * Freeze one team's membership set before deletion. PostgreSQL foreign-key
 * inserts take a KEY SHARE lock on this row, so insert-first is visible after
 * this lock waits and delete-first prevents a late membership from surviving.
 */
export async function lockTeamTeamRow(
  params: { orgId: string; teamId: string },
  deps: { prisma: TeamLockPrisma },
): Promise<{ id: string; isDefault: boolean } | null> {
  const rows = await deps.prisma.$queryRaw<Array<{ id: string; isDefault: boolean }>>(
    Prisma.sql`
      SELECT t.id, t."is_default" AS "isDefault"
      FROM "teams" t
      WHERE t.id = ${params.teamId}
        AND t."org_id" = ${params.orgId}
      FOR UPDATE OF t
    `,
  );
  return rows[0] ?? null;
}

/**
 * Lock one user's organisation membership first, then their team membership
 * rows in stable id order. Token exchange and every status-changing lifecycle
 * path use this same order, so ACTIVE-scope decisions are linearized with
 * deactivation, removal, reactivation, and invite-link joins.
 */
export async function lockTeamMembershipRows(
  params: {
    userId: string;
    orgId: string;
    teamId?: string;
  },
  deps: { prisma: TeamLockPrisma },
): Promise<void> {
  await deps.prisma.$queryRaw(
    Prisma.sql`
      SELECT om.id
      FROM "org_members" om
      WHERE om."org_id" = ${params.orgId}
        AND om."user_id" = ${params.userId}
      ORDER BY om.id
      FOR UPDATE OF om
    `,
  );

  await deps.prisma.$queryRaw(
    params.teamId
      ? Prisma.sql`
          SELECT tm.id
          FROM "team_members" tm
          INNER JOIN "teams" t ON t.id = tm."team_id"
          WHERE t."org_id" = ${params.orgId}
            AND tm."user_id" = ${params.userId}
            AND tm."team_id" = ${params.teamId}
          ORDER BY tm.id
          FOR UPDATE OF tm
        `
      : Prisma.sql`
          SELECT tm.id
          FROM "team_members" tm
          INNER JOIN "teams" t ON t.id = tm."team_id"
          WHERE t."org_id" = ${params.orgId}
            AND tm."user_id" = ${params.userId}
          ORDER BY tm.id
          FOR UPDATE OF tm
        `,
  );
}

/**
 * Require the exact selected organisation and team to belong to this client
 * domain and require ACTIVE membership at both levels. Lifecycle tombstones
 * are deliberately never treated as reusable membership.
 */
export async function assertActiveTeamScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: { prisma: TeamScopePrisma },
): Promise<void> {
  if (!(await activeTeamScopeExists({ ...params, allowCrossDomain: false }, deps))) {
    rejectTeamScope();
  }
}

/**
 * Validate a selected team against the client domain first. A cross-domain
 * retry is permitted only for one unambiguous, active UOA product mapping and
 * still requires exact ACTIVE organisation and team memberships.
 */
export async function assertActiveClientTeamScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: {
    crossProductPrisma?: TeamScopePrisma;
    policyPrisma?: ProductTeamPolicyPrisma;
    prisma: TeamScopePrisma;
  },
): Promise<void> {
  if (await activeTeamScopeExists({ ...params, allowCrossDomain: false }, deps)) return;

  const policy = await resolveProductTeamPolicy(
    { domain: params.domain },
    {
      prisma: deps.policyPrisma ?? (getAdminPrisma() as unknown as ProductTeamPolicyPrisma),
    },
  );
  if (
    policy.scope !== 'all_active_memberships' ||
    !(await activeTeamScopeExists(
      { ...params, allowCrossDomain: true },
      {
        prisma: deps.crossProductPrisma ?? (getAdminPrisma() as unknown as TeamScopePrisma),
      },
    ))
  ) {
    rejectTeamScope();
  }
}

/** Lock the exact membership rows, then validate their current committed state. */
export async function lockAndAssertActiveTeamScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: { prisma: TeamScopePrisma & TeamLockPrisma },
): Promise<void> {
  const orgId = params.orgId ?? undefined;
  const teamId = params.teamId ?? undefined;
  if (!orgId && !teamId) return;
  if (!orgId || !teamId) rejectTeamScope();

  await lockTeamMembershipRows({ userId: params.userId, orgId, teamId }, deps);
  await assertActiveTeamScope(params, deps);
}

/** Lock the exact rows, then apply the client/product-aware scope policy. */
export async function lockAndAssertActiveClientTeamScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: {
    crossProductPrisma?: TeamScopePrisma & TeamLockPrisma;
    policyPrisma?: ProductTeamPolicyPrisma;
    prisma: TeamScopePrisma & TeamLockPrisma;
  },
): Promise<void> {
  const orgId = params.orgId ?? undefined;
  const teamId = params.teamId ?? undefined;
  if (!orgId && !teamId) return;
  if (!orgId || !teamId) rejectTeamScope();

  // Preserve the legacy transaction and lock order when the selected team
  // belongs to the client domain. Cross-domain membership rows and the
  // product-key policy are never read through the tenant role: the caller must
  // use (or this service defaults to) the BYPASSRLS client.
  if (await activeTeamScopeExists({ ...params, allowCrossDomain: false }, deps)) {
    await lockTeamMembershipRows({ userId: params.userId, orgId, teamId }, deps);
    await assertActiveTeamScope(params, deps);
    return;
  }

  const policyPrisma =
    deps.policyPrisma ?? (getAdminPrisma() as unknown as ProductTeamPolicyPrisma);
  const policy = await resolveProductTeamPolicy(
    { domain: params.domain },
    { prisma: policyPrisma },
  );
  if (policy.scope !== 'all_active_memberships') rejectTeamScope();

  const crossProductPrisma =
    deps.crossProductPrisma ??
    (getAdminPrisma() as unknown as TeamScopePrisma & TeamLockPrisma);
  await lockTeamMembershipRows(
    { userId: params.userId, orgId, teamId },
    { prisma: crossProductPrisma },
  );
  if (
    !(await activeTeamScopeExists(
      { ...params, allowCrossDomain: true },
      { prisma: crossProductPrisma },
    ))
  ) {
    rejectTeamScope();
  }
}

/**
 * Refresh-specific fail-closed wrapper around the canonical ordered membership lock. Keeping the
 * mapping here prevents token orchestration from duplicating team-policy error semantics.
 */
export async function lockAndAssertRefreshTeamScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: {
    crossProductPrisma?: TeamScopePrisma & TeamLockPrisma;
    policyPrisma?: ProductTeamPolicyPrisma;
    prisma: TeamScopePrisma & TeamLockPrisma;
  },
): Promise<void> {
  try {
    await lockAndAssertActiveClientTeamScope(params, deps);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
    }
    throw error;
  }
}
