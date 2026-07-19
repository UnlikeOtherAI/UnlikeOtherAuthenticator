import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getPrisma } from '../db/prisma.js';

type FirstLoginPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
  orgMember: Pick<PrismaClient['orgMember'], 'findMany'>;
  teamMember: Pick<PrismaClient['teamMember'], 'findMany'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findMany'>;
};

/**
 * The "is this TeamInvite row still a real pending invite" predicate (design §4.7): unaccepted,
 * undeclined, unrevoked, and not expired. This is the single source of truth for that eligibility
 * check — `buildFirstLoginBlock`, `buildWorkspaceChoices` (the chooser), the gap-fix A `/org/me`
 * sidebar (`workspace-directory.service.ts`), and the "Invited" tab (`team-invite.service.invited.ts`)
 * all compose it with their own scoping (email+domain vs team+org) rather than duplicating it.
 *
 * `includePendingApproval` defaults to false, matching the historical chooser/firstLogin behaviour:
 * an invite still awaiting member-invite approval (design §4.7 Phase 4) is not yet a real pending
 * invite FOR THE INVITEE. The "Invited" tab (an admin's view) passes `true` — an admin managing
 * invites must see ones still awaiting their own approval.
 */
export function pendingInviteStatusWhere(params: {
  now: Date;
  includePendingApproval?: boolean;
}): Prisma.TeamInviteWhereInput {
  return {
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    approvalStatus: params.includePendingApproval
      ? { in: ['NOT_REQUIRED', 'APPROVED', 'PENDING'] }
      : { in: ['NOT_REQUIRED', 'APPROVED'] },
    OR: [{ expiresAt: null }, { expiresAt: { gt: params.now } }],
  };
}

export type FirstLoginMembershipOrg = {
  orgId: string;
  role: string;
};

export type FirstLoginMembershipTeam = {
  teamId: string;
  orgId: string;
  role: string;
  // Design §11.3 (gap-fix A Task 3): echoed everywhere teams are listed.
  iconUrl: string | null;
};

export type FirstLoginPendingInvite = {
  inviteId: string;
  type: 'team';
  orgId: string;
  teamId: string;
  teamName: string;
};

export type FirstLoginCapabilities = {
  can_create_org: boolean;
  can_accept_invite: boolean;
};

export type FirstLoginBlock = {
  memberships: {
    orgs: FirstLoginMembershipOrg[];
    teams: FirstLoginMembershipTeam[];
  };
  pending_invites: FirstLoginPendingInvite[];
  capabilities: FirstLoginCapabilities;
};

export async function buildFirstLoginBlock(
  params: {
    userId: string;
    config: ClientConfig;
  },
  deps?: { prisma?: FirstLoginPrisma; now?: () => Date },
): Promise<FirstLoginBlock | null> {
  if (!params.config.org_features?.enabled) {
    return null;
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as FirstLoginPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user) {
    return null;
  }

  const domain = params.config.domain.trim().toLowerCase().replace(/\.$/, '');

  const [orgRows, teamRows, inviteRows] = await Promise.all([
    prisma.orgMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        org: { domain },
      },
      select: {
        orgId: true,
        role: true,
      },
    }),
    prisma.teamMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: { org: { domain } },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { orgId: true, iconUrl: true } },
      },
    }),
    prisma.teamInvite.findMany({
      where: {
        email: user.email,
        org: { domain },
        // Task 3/4 (design §4.7): expired invites and invites awaiting member-invite approval are
        // not yet real pending invites for the invitee — excluded from every pending-invite surface.
        ...pendingInviteStatusWhere({ now }),
      },
      select: {
        id: true,
        orgId: true,
        teamId: true,
        team: { select: { name: true } },
      },
    }),
  ]);

  const orgs: FirstLoginMembershipOrg[] = orgRows.map((row) => ({
    orgId: row.orgId,
    role: row.role,
  }));

  const teams: FirstLoginMembershipTeam[] = teamRows.map((row) => ({
    teamId: row.teamId,
    orgId: row.team.orgId,
    role: row.teamRole,
    iconUrl: row.team.iconUrl,
  }));

  const pendingInvites: FirstLoginPendingInvite[] = inviteRows.map((row) => ({
    inviteId: row.id,
    type: 'team',
    orgId: row.orgId,
    teamId: row.teamId,
    teamName: row.team.name,
  }));

  const capabilities: FirstLoginCapabilities = {
    can_create_org: Boolean(params.config.org_features?.allow_user_create_org),
    can_accept_invite: pendingInvites.length > 0,
  };

  return {
    memberships: { orgs, teams },
    pending_invites: pendingInvites,
    capabilities,
  };
}

export type WorkspaceChoiceTeam = {
  teamId: string;
  orgId: string;
  name: string;
  role: string;
  // Design §11.3 (gap-fix A Task 3) — matches `Auth/src/hooks/use-popup.tsx`'s `TeamChoice.iconUrl`.
  iconUrl: string | null;
  // Gap-fix B Task 2 (design §11.4): lets the client match a `team_hint` deep-link param by slug as
  // well as by id — matches `Auth/src/hooks/use-popup.tsx`'s `TeamChoice.slug`.
  slug: string;
};

export type WorkspaceChoicePendingInvite = {
  inviteId: string;
  teamName: string;
  invitedBy: string | null;
};

export type WorkspaceChoices = {
  teams: WorkspaceChoiceTeam[];
  pending_invites: WorkspaceChoicePendingInvite[];
  can_create_org: boolean;
};

export type AutoSelectedWorkspace = {
  orgId: string;
  teamId: string;
};

/**
 * `workspace_selection: "auto"` skips the chooser only when there is exactly one unambiguous
 * ACTIVE workspace and no pending invite. The skipped chooser is still a workspace selection:
 * callers must bind this exact org/team to the authorization code (and any intervening 2FA
 * bridge), just as `/auth/select-team` does for an explicit click.
 */
export function resolveAutoSelectedWorkspace(
  choices: WorkspaceChoices,
): AutoSelectedWorkspace | null {
  if (choices.teams.length !== 1 || choices.pending_invites.length !== 0) {
    return null;
  }

  const [team] = choices.teams;
  if (!team) return null;
  return { orgId: team.orgId, teamId: team.teamId };
}

type WorkspaceChooserPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
  teamMember: Pick<PrismaClient['teamMember'], 'findMany'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findMany'>;
};

/**
 * Phase 3b (design §4.3): the post-verification workspace chooser payload. Only ever built AFTER
 * identity verification (a successful /auth/verify-code or a valid login_token) — never before, so
 * it never leaks workspace names or membership existence to an unverified caller. Only ACTIVE team
 * memberships are listed; DEACTIVATED/REMOVED rows are silently omitted (design §8: a suspended user
 * never sees "you were suspended", the team just isn't there).
 */
export async function buildWorkspaceChoices(
  params: {
    userId: string;
    config: ClientConfig;
  },
  deps?: { prisma?: WorkspaceChooserPrisma; now?: () => Date },
): Promise<WorkspaceChoices> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as WorkspaceChooserPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user) {
    return { teams: [], pending_invites: [], can_create_org: false };
  }

  const domain = params.config.domain.trim().toLowerCase().replace(/\.$/, '');

  const [teamRows, inviteRows] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: { org: { domain } },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { name: true, slug: true, orgId: true, iconUrl: true } },
      },
    }),
    prisma.teamInvite.findMany({
      where: {
        email: user.email,
        org: { domain },
        // Task 3/4 (design §4.7): expired invites and invites awaiting member-invite approval are
        // not yet real pending invites for the invitee — excluded from the chooser.
        ...pendingInviteStatusWhere({ now }),
      },
      select: {
        id: true,
        team: { select: { name: true } },
        invitedByName: true,
        invitedByEmail: true,
      },
    }),
  ]);

  const teams: WorkspaceChoiceTeam[] = teamRows.map((row) => ({
    teamId: row.teamId,
    orgId: row.team.orgId,
    name: row.team.name,
    role: row.teamRole,
    iconUrl: row.team.iconUrl,
    slug: row.team.slug,
  }));

  const pendingInvites: WorkspaceChoicePendingInvite[] = inviteRows.map((row) => ({
    inviteId: row.id,
    teamName: row.team.name,
    invitedBy: row.invitedByName ?? row.invitedByEmail ?? null,
  }));

  return {
    teams,
    pending_invites: pendingInvites,
    can_create_org: Boolean(params.config.org_features?.allow_user_create_org),
  };
}
