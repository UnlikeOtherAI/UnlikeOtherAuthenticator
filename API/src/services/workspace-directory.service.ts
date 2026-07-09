import type { PrismaClient } from '@prisma/client';

import { getPrisma } from '../db/prisma.js';
import { pendingInviteStatusWhere } from './first-login.service.js';

// Gap-fix A Task 1 (design §11.4 "sidebar workspace stack" + §11.3 icons): the `GET /org/me`
// sidebar enrichment. Split out of `org-context.service.ts` (per the gap-fix spec) rather than
// grown inline — a distinct read concern (refresh-token aggregation + the shared pending-invite
// eligibility filter) with its own mock surface for unit tests, and keeps both files well under
// the project's 500-line cap.

export type WorkspaceEntry = {
  teamId: string;
  orgId: string;
  name: string;
  slug: string;
  orgName: string;
  iconUrl: string | null;
  role: string;
  // Most recent session opened for this workspace (max(createdAt) of the caller's scoped refresh
  // tokens); null when no scoped session was ever opened (e.g. pre-chooser sessions, which carry a
  // null teamId, or a workspace never actually signed into).
  lastLoginAt: Date | null;
};

export type SidebarPendingInvite = {
  inviteId: string;
  teamId: string;
  teamName: string;
  invitedBy: string | null;
  expiresAt: Date | null;
};

type WorkspaceDirectoryPrisma = {
  teamMember: Pick<PrismaClient['teamMember'], 'findMany'>;
  refreshToken: Pick<PrismaClient['refreshToken'], 'groupBy'>;
  user: Pick<PrismaClient['user'], 'findUnique'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findMany'>;
};

type WorkspaceDirectoryDeps = {
  prisma?: WorkspaceDirectoryPrisma;
  now?: () => Date;
};

function compareWorkspaceEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  const aTime = a.lastLoginAt ? a.lastLoginAt.getTime() : null;
  const bTime = b.lastLoginAt ? b.lastLoginAt.getTime() : null;

  if (aTime !== bTime) {
    // nulls last
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime; // desc
  }

  return a.name.localeCompare(b.name);
}

/**
 * The sidebar workspace stack (design §11.4): one entry per ACTIVE team membership of the caller
 * on this domain, ordered `lastLoginAt` DESC with nulls last, then `name` ASC.
 *
 * `lastLoginAt` is derived from the caller's own `refresh_tokens` rows (`max(createdAt)` scoped by
 * `userId` + `domain` + `teamId`). `refresh_tokens` is RLS-classified as a *domain*-scoped table
 * (its SELECT policy is `domain = current_setting('app.domain')`), not an org_id-scoped one —
 * unlike `teams`/`team_members`/`org_members`. `/org/me`'s tenant transaction always sets
 * `app.domain` from the verified config domain (it deliberately leaves `app.org_id` empty for the
 * bootstrap predicate — see `row-level-security.md` §7/§11 and `org-context.service.ts`), so the
 * request's ordinary tenant-scoped Prisma client can already read the caller's own refresh-token
 * rows for this domain. No escalation to the BYPASSRLS admin client is needed for this lookup —
 * callers should pass the same tenant-tx client used for `getUserOrgContext`.
 */
export async function buildSidebarWorkspaces(
  params: { userId: string; domain: string },
  deps?: WorkspaceDirectoryDeps,
): Promise<WorkspaceEntry[]> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as WorkspaceDirectoryPrisma);

  const memberships = await prisma.teamMember.findMany({
    where: {
      userId: params.userId,
      status: 'ACTIVE',
      team: { org: { domain: params.domain } },
    },
    select: {
      teamId: true,
      teamRole: true,
      team: {
        select: {
          orgId: true,
          name: true,
          slug: true,
          iconUrl: true,
          org: { select: { name: true } },
        },
      },
    },
  });

  if (memberships.length === 0) return [];

  const teamIds = memberships.map((membership) => membership.teamId);
  const loginRows = await prisma.refreshToken.groupBy({
    by: ['teamId'],
    where: {
      userId: params.userId,
      domain: params.domain,
      teamId: { in: teamIds },
    },
    _max: { createdAt: true },
  });

  const lastLoginByTeam = new Map<string, Date>();
  for (const row of loginRows) {
    if (row.teamId && row._max.createdAt) {
      lastLoginByTeam.set(row.teamId, row._max.createdAt);
    }
  }

  const entries: WorkspaceEntry[] = memberships.map((membership) => ({
    teamId: membership.teamId,
    orgId: membership.team.orgId,
    name: membership.team.name,
    slug: membership.team.slug,
    orgName: membership.team.org.name,
    iconUrl: membership.team.iconUrl,
    role: membership.teamRole,
    lastLoginAt: lastLoginByTeam.get(membership.teamId) ?? null,
  }));

  return entries.sort(compareWorkspaceEntries);
}

/**
 * The sidebar's `pending_invites[]` (design §11.4): same eligibility filter as the chooser's
 * `buildWorkspaceChoices` (`pendingInviteStatusWhere`, `includePendingApproval` defaults to false —
 * an invite still awaiting member-invite approval isn't a real pending invite for the invitee yet).
 */
export async function buildSidebarPendingInvites(
  params: { userId: string; domain: string },
  deps?: WorkspaceDirectoryDeps,
): Promise<SidebarPendingInvite[]> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as WorkspaceDirectoryPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user) return [];

  const invites = await prisma.teamInvite.findMany({
    where: {
      email: user.email,
      org: { domain: params.domain },
      ...pendingInviteStatusWhere({ now }),
    },
    select: {
      id: true,
      teamId: true,
      team: { select: { name: true } },
      invitedByName: true,
      invitedByEmail: true,
      expiresAt: true,
    },
  });

  return invites.map((row) => ({
    inviteId: row.id,
    teamId: row.teamId,
    teamName: row.team.name,
    invitedBy: row.invitedByName ?? row.invitedByEmail ?? null,
    expiresAt: row.expiresAt,
  }));
}
