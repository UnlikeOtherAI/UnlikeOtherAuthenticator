import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { avatarImageBaseUrl, publicTeamAvatarImageUrl } from '../utils/avatar-url.js';
import { pendingInviteStatusWhere } from './first-login.service.js';
import { resolveInviterLabel } from './invite-inviter-label.service.js';
import {
  type ProductTeamPolicy,
} from './product-team-policy.service.js';

// Gap-fix A Task 1 (design §11.4 "sidebar team stack" + §11.3 icons): the `GET /org/me`
// sidebar enrichment. Split out of `org-context.service.ts` (per the gap-fix spec) rather than
// grown inline — a distinct read concern (refresh-token aggregation + the shared pending-invite
// eligibility filter) with its own mock surface for unit tests, and keeps both files well under
// the project's 500-line cap.

export type TeamEntry = {
  teamId: string;
  orgId: string;
  name: string;
  slug: string;
  orgName: string;
  /**
   * The organisation's slug — its tenant DNS label.
   *
   * Present so a product can build a team's address without a second lookup:
   * a team slug is unique only inside its organisation, so it is never a
   * hostname on its own (Docs/brief.md, "Tenant Subdomain Contract"). The
   * picker lists teams across organisations, which is exactly where the
   * organisation label is not already known from `active.tenantSlug`.
   */
  orgSlug: string;
  iconUrl: string | null;
  /** Public, always-resolving team image: uploaded → proxied iconUrl → generated. */
  avatarImageUrl: string;
  role: string;
  // Most recent session opened for this team (max(createdAt) of the caller's scoped refresh
  // tokens); null when no scoped session was ever opened (e.g. pre-chooser sessions, which carry a
  // null teamId, or a team never actually signed into).
  lastLoginAt: Date | null;
};

export type SidebarPendingInvite = {
  inviteId: string;
  orgId: string;
  /**
   * The inviting organisation's name and slug.
   *
   * An invitation can name a team in an organisation the caller is not signed
   * into, and two organisations can each own a team called "General" — so a
   * product cannot label the card from the singular `org.org_id` block or from
   * `team_directory` (which lists teams the caller is already a member of, and
   * therefore never contains the invited team).
   */
  orgName: string;
  orgSlug: string;
  teamId: string;
  teamName: string;
  invitedBy: string | null;
  expiresAt: Date | null;
};

type TeamDirectoryPrisma = {
  teamMember: Pick<PrismaClient['teamMember'], 'findMany'>;
  refreshToken: Pick<PrismaClient['refreshToken'], 'groupBy'>;
  user: Pick<PrismaClient['user'], 'findUnique'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findMany'>;
};

type TeamDirectoryDeps = {
  crossProductPrisma?: Pick<PrismaClient, 'teamMember'>;
  /**
   * The client the pending-invite read runs on. Defaults to the BYPASSRLS admin
   * client for the reason spelled out on `buildSidebarPendingInvites`: the
   * `team_invites` RLS policy is keyed on `app.org_id` alone, so the request's
   * own tenant transaction can only ever see invitations belonging to the
   * organisation the access token is scoped to.
   */
  invitePrisma?: Pick<PrismaClient, 'teamInvite' | 'user'>;
  policy?: ProductTeamPolicy;
  prisma?: TeamDirectoryPrisma;
  now?: () => Date;
};

function compareTeamEntries(a: TeamEntry, b: TeamEntry): number {
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
 * The sidebar team stack (design §11.4): one entry per ACTIVE team membership the caller may
 * enter. A product with the server-owned `all_active_memberships` policy receives the same
 * cross-product directory as its authenticated chooser; otherwise this remains domain-scoped.
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
export async function buildSidebarTeams(
  params: { userId: string; domain: string },
  deps?: TeamDirectoryDeps,
): Promise<TeamEntry[]> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as TeamDirectoryPrisma);

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
          org: { select: { name: true, slug: true } },
        },
      },
    },
  });

  const policy = deps?.policy ?? { scope: 'client_domain' as const };
  const crossProductMemberships = policy.scope === 'all_active_memberships'
    ? await (deps?.crossProductPrisma ?? getAdminPrisma()).teamMember.findMany({
        where: {
          userId: params.userId,
          status: 'ACTIVE',
          team: { org: { members: { some: { userId: params.userId, status: 'ACTIVE' } } } },
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
              org: { select: { name: true, slug: true } },
            },
          },
        },
      })
    : [];
  const directoryMemberships = [
    ...new Map(
      [...memberships, ...crossProductMemberships].map((membership) => [membership.teamId, membership]),
    ).values(),
  ];
  if (directoryMemberships.length === 0) return [];

  // Login recency remains limited to this product's domain. Cross-product access grants a
  // team directory, not another product's session history.
  const teamIds = memberships.map((membership) => membership.teamId);
  const loginRows = teamIds.length > 0 ? await prisma.refreshToken.groupBy({
    by: ['teamId'],
    where: {
      userId: params.userId,
      domain: params.domain,
      teamId: { in: teamIds },
    },
    _max: { createdAt: true },
  }) : [];

  const lastLoginByTeam = new Map<string, Date>();
  for (const row of loginRows) {
    if (row.teamId && row._max.createdAt) {
      lastLoginByTeam.set(row.teamId, row._max.createdAt);
    }
  }

  const avatarBaseUrl = avatarImageBaseUrl();
  const entries: TeamEntry[] = directoryMemberships.map((membership) => ({
    teamId: membership.teamId,
    orgId: membership.team.orgId,
    name: membership.team.name,
    slug: membership.team.slug,
    orgName: membership.team.org.name,
    orgSlug: membership.team.org.slug,
    iconUrl: membership.team.iconUrl,
    avatarImageUrl: publicTeamAvatarImageUrl({
      baseUrl: avatarBaseUrl,
      teamId: membership.teamId,
    }),
    role: membership.teamRole,
    lastLoginAt: lastLoginByTeam.get(membership.teamId) ?? null,
  }));

  return entries.sort(compareTeamEntries);
}

/**
 * The organisations an invitation may be reported from, as a `TeamInvite` filter.
 *
 * Deliberately the same reach `buildSidebarTeams` has: every organisation on this product's
 * domain, plus — only for a product the server mapped to `all_active_memberships` — every
 * organisation the caller already holds an ACTIVE membership in, which is where an invitation
 * to a *second* team of an organisation founded through another product domain lives.
 */
function inviteOrgReach(params: {
  userId: string;
  domain: string;
  policy: ProductTeamPolicy;
}): Prisma.TeamInviteWhereInput {
  const reach: Prisma.TeamInviteWhereInput[] = [{ org: { domain: params.domain } }];
  if (params.policy.scope === 'all_active_memberships') {
    reach.push({
      org: { members: { some: { userId: params.userId, status: 'ACTIVE' } } },
    });
  }
  return { OR: reach };
}

/**
 * The sidebar's `pending_invites[]` (design §11.4): same eligibility filter as the chooser's
 * `buildSessionChoices` (`pendingInviteStatusWhere`, `includePendingApproval` defaults to false —
 * an invite still awaiting member-invite approval isn't a real pending invite for the invitee yet).
 *
 * **Why this read does not use the request's tenant transaction.** `team_invites` is
 * org_id-scoped under RLS — `team_invites_select` is `org_id = app.org_id` and nothing else
 * (20260423000001_rls_enable_policies) — and `/org/me` runs its transaction with `app.org_id`
 * resolved from the caller's access token. Reading invitations there answers only for the one
 * organisation the token is scoped to, and silently drops every invitation from a sibling
 * organisation: exactly the "the chooser offers it at sign-in, the product never sees it"
 * defect. A user's own pending invitations are not tenant data of the organisation they are
 * signed into, so the read runs on the admin client and is bounded by the two filters that
 * actually define it — the caller's OWN verified address (resolved from their user row, never
 * from a parameter) and the product's organisation reach above. That is the same set the hosted
 * chooser already shows this same user at sign-in.
 */
export async function buildSidebarPendingInvites(
  params: { userId: string; domain: string },
  deps?: TeamDirectoryDeps,
): Promise<SidebarPendingInvite[]> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as TeamDirectoryPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user) return [];

  const invitePrisma = deps?.invitePrisma ?? getAdminPrisma();
  const policy = deps?.policy ?? { scope: 'client_domain' as const };

  const invites = await invitePrisma.teamInvite.findMany({
    // `AND`, not a spread: `pendingInviteStatusWhere` already carries its own top-level `OR`
    // (the "no expiry, or not yet expired" pair). Spreading the reach's `OR` beside it would
    // overwrite that key and quietly re-admit expired invitations.
    where: {
      AND: [
        { email: user.email },
        pendingInviteStatusWhere({ now }),
        inviteOrgReach({ userId: params.userId, domain: params.domain, policy }),
      ],
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      team: { select: { name: true } },
      org: { select: { name: true, slug: true } },
      invitedByName: true,
      invitedByEmail: true,
      invitedByUserId: true,
      expiresAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // The inviter may be recorded as a user id alone (every member-initiated invitation is), and
  // that user can belong to a sibling organisation — resolve on the same client as the rows.
  const invitedBy = await resolveInviterLabel(invites, { prisma: invitePrisma });

  return invites.map((row) => ({
    inviteId: row.id,
    orgId: row.orgId,
    orgName: row.org.name,
    orgSlug: row.org.slug,
    teamId: row.teamId,
    teamName: row.team.name,
    invitedBy: invitedBy(row),
    expiresAt: row.expiresAt,
  }));
}
