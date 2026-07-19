import { Prisma, type PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

type WorkspaceScopePrisma = Pick<
  PrismaClient,
  'organisation' | 'orgMember' | 'team' | 'teamMember'
>;
type WorkspaceLockPrisma = Pick<PrismaClient, '$queryRaw'>;

function rejectWorkspaceScope(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

/** Lock a workspace container before a destructive operation reaches membership rows. */
export async function lockWorkspaceOrganisationRow(
  orgId: string,
  deps: { prisma: WorkspaceLockPrisma },
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
export async function lockWorkspaceTeamRow(
  params: { orgId: string; teamId: string },
  deps: { prisma: WorkspaceLockPrisma },
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
export async function lockWorkspaceMembershipRows(
  params: {
    userId: string;
    orgId: string;
    teamId?: string;
  },
  deps: { prisma: WorkspaceLockPrisma },
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
export async function assertActiveWorkspaceScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: { prisma: WorkspaceScopePrisma },
): Promise<void> {
  const orgId = params.orgId ?? undefined;
  const teamId = params.teamId ?? undefined;
  if (!orgId && !teamId) return;
  if (!orgId || !teamId) rejectWorkspaceScope();

  const [orgMember, teamMember] = await Promise.all([
    deps.prisma.orgMember.findFirst({
      where: {
        orgId,
        userId: params.userId,
        status: 'ACTIVE',
        org: { domain: params.domain },
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
          org: { domain: params.domain },
        },
      },
      select: { id: true },
    }),
  ]);

  if (!orgMember || !teamMember) rejectWorkspaceScope();
}

/** Lock the exact membership rows, then validate their current committed state. */
export async function lockAndAssertActiveWorkspaceScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: { prisma: WorkspaceScopePrisma & WorkspaceLockPrisma },
): Promise<void> {
  const orgId = params.orgId ?? undefined;
  const teamId = params.teamId ?? undefined;
  if (!orgId && !teamId) return;
  if (!orgId || !teamId) rejectWorkspaceScope();

  await lockWorkspaceMembershipRows(
    { userId: params.userId, orgId, teamId },
    deps,
  );
  await assertActiveWorkspaceScope(params, deps);
}
