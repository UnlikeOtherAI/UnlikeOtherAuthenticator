import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { avatarImageBaseUrl, publicTeamAvatarImageUrl } from '../utils/avatar-url.js';
import { configRoleHoldsCapability } from './role-grants.js';
import {
  resolveProductWorkspacePolicy,
  type ProductWorkspacePolicy,
  type ProductWorkspacePolicyPrisma,
} from './product-workspace-policy.service.js';

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
  deps?: {
    policy?: ProductWorkspacePolicy;
    policyPrisma?: ProductWorkspacePolicyPrisma;
    crossProductPrisma?: FirstLoginPrisma;
    prisma?: FirstLoginPrisma;
    now?: () => Date;
  },
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

  const [sameDomainOrgRows, sameDomainTeamRows, inviteRows, policy] = await Promise.all([
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
    deps?.policy ??
      resolveProductWorkspacePolicy(
        { domain },
        {
          now: deps?.now,
          prisma:
            deps?.policyPrisma ?? (getAdminPrisma() as unknown as ProductWorkspacePolicyPrisma),
        },
      ),
  ]);

  let productOrgRows: typeof sameDomainOrgRows = [];
  let productTeamRows: typeof sameDomainTeamRows = [];
  if (policy.scope === 'all_active_memberships') {
    // Product workspace expansion is a pre-auth, cross-tenant operation. It is
    // intentionally isolated on the BYPASSRLS client; the supplied tenant
    // transaction still contributes same-domain rows created earlier in the
    // login transaction.
    const crossProductPrisma =
      deps?.crossProductPrisma ?? (getAdminPrisma() as unknown as FirstLoginPrisma);
    [productOrgRows, productTeamRows] = await Promise.all([
      crossProductPrisma.orgMember.findMany({
        where: { userId: params.userId, status: 'ACTIVE' },
        select: { orgId: true, role: true },
      }),
      crossProductPrisma.teamMember.findMany({
        where: {
          userId: params.userId,
          status: 'ACTIVE',
          team: {
            org: {
              members: {
                some: { userId: params.userId, status: 'ACTIVE' },
              },
            },
          },
        },
        select: {
          teamId: true,
          teamRole: true,
          team: { select: { orgId: true, iconUrl: true } },
        },
      }),
    ]);
  }

  const orgRows = [
    ...new Map([...sameDomainOrgRows, ...productOrgRows].map((row) => [row.orgId, row])).values(),
  ];
  const teamRows = [
    ...new Map(
      [...sameDomainTeamRows, ...productTeamRows].map((row) => [row.teamId, row]),
    ).values(),
  ];

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
  /**
   * Always-resolving workspace image (Docs/Auth/avatars.md §11.4), in the credential-free
   * `/teams/:teamId/avatar` form — the chooser renders in a popup that holds no bearer, so this is
   * the only avatar URL form it can put in an `<img src>`. Never null: uploaded → proxied
   * `iconUrl` → generated.
   */
  avatarImageUrl: string;
  /**
   * The owning organisation's name — two workspaces can share a name across different orgs (a
   * "General" in each), so the chooser needs the level above to tell them apart. Null only when a
   * caller supplied a team row without the org join; the query here always selects it.
   */
  orgName: string | null;
  // Gap-fix B Task 2 (design §11.4): lets the client match a `team_hint` deep-link param by slug as
  // well as by id — matches `Auth/src/hooks/use-popup.tsx`'s `TeamChoice.slug`.
  slug: string;
};

export type WorkspaceChoicePendingInvite = {
  inviteId: string;
  teamName: string;
  invitedBy: string | null;
};

/**
 * An organisation this user may add a further workspace (team) to from the chooser: they are an
 * ACTIVE owner/admin of it and the domain has opted in with `org_features.allow_user_create_team`.
 *
 * Deliberately distinct from `can_create_org`, which is about a user's *first* organisation
 * (brief §1718). An org is a level above a workspace: this list says "you may create a workspace
 * **here**", so the client can offer creation per organisation rather than as one ambiguous button
 * when the user belongs to several.
 */
export type WorkspaceChoiceCreatableOrg = {
  orgId: string;
  orgName: string;
};

export type WorkspaceChoices = {
  teams: WorkspaceChoiceTeam[];
  pending_invites: WorkspaceChoicePendingInvite[];
  can_create_org: boolean;
  creatable_orgs: WorkspaceChoiceCreatableOrg[];
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

/**
 * An auto-selection flow needs the chooser whenever there is a real decision or next action that
 * cannot be represented by an authorization code alone. In particular, an empty membership list
 * with `can_create_org` is the create-workspace entrypoint, not an unscoped-login fallback.
 */
export function shouldPresentWorkspaceChooser(
  choices: WorkspaceChoices,
  autoSelectedWorkspace = resolveAutoSelectedWorkspace(choices),
): boolean {
  return (
    !autoSelectedWorkspace &&
    (choices.teams.length >= 2 || choices.pending_invites.length > 0 || choices.can_create_org)
  );
}

type WorkspaceChooserPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
  orgMember: Pick<PrismaClient['orgMember'], 'findMany'>;
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
  deps?: {
    policy?: ProductWorkspacePolicy;
    policyPrisma?: ProductWorkspacePolicyPrisma;
    crossProductPrisma?: WorkspaceChooserPrisma;
    prisma?: WorkspaceChooserPrisma;
    now?: () => Date;
  },
): Promise<WorkspaceChoices> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as WorkspaceChooserPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user) {
    return { teams: [], pending_invites: [], can_create_org: false, creatable_orgs: [] };
  }

  const domain = params.config.domain.trim().toLowerCase().replace(/\.$/, '');
  const policy =
    deps?.policy ??
    (await resolveProductWorkspacePolicy(
      { domain },
      {
        now: deps?.now,
        prisma: deps?.policyPrisma ?? (getAdminPrisma() as unknown as ProductWorkspacePolicyPrisma),
      },
    ));

  // An org is the level above a workspace: this decides which organisations the user may add a
  // workspace TO. Only queried when the domain has opted in — otherwise the chooser offers no
  // creation and the read would be dead weight on every login.
  const canCreateTeams = Boolean(
    params.config.org_features?.enabled && params.config.org_features.allow_user_create_team,
  );

  const [sameDomainTeamRows, inviteRows, orgRows] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: { org: { domain } },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { name: true, slug: true, orgId: true, iconUrl: true, org: { select: { name: true } } } },
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
    canCreateTeams
      ? prisma.orgMember.findMany({
          where: { userId: params.userId, status: 'ACTIVE', org: { domain } },
          select: { orgId: true, role: true, org: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ]);

  let productTeamRows: typeof sameDomainTeamRows = [];
  if (policy.scope === 'all_active_memberships') {
    const crossProductPrisma =
      deps?.crossProductPrisma ?? (getAdminPrisma() as unknown as WorkspaceChooserPrisma);
    productTeamRows = await crossProductPrisma.teamMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: {
          org: {
            members: {
              some: { userId: params.userId, status: 'ACTIVE' },
            },
          },
        },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { name: true, slug: true, orgId: true, iconUrl: true, org: { select: { name: true } } } },
      },
    });
  }

  const teamRows = [
    ...new Map(
      [...sameDomainTeamRows, ...productTeamRows].map((row) => [row.teamId, row]),
    ).values(),
  ];

  const avatarBaseUrl = avatarImageBaseUrl();
  const teams: WorkspaceChoiceTeam[] = teamRows.map((row) => ({
    teamId: row.teamId,
    orgId: row.team.orgId,
    name: row.team.name,
    role: row.teamRole,
    iconUrl: row.team.iconUrl,
    avatarImageUrl: publicTeamAvatarImageUrl({ baseUrl: avatarBaseUrl, teamId: row.teamId }),
    orgName: row.team.org?.name ?? null,
    slug: row.team.slug,
  }));

  const pendingInvites: WorkspaceChoicePendingInvite[] = inviteRows.map((row) => ({
    inviteId: row.id,
    teamName: row.team.name,
    invitedBy: row.invitedByName ?? row.invitedByEmail ?? null,
  }));

  // Creating a workspace inside an org needs `teams.manage` at ORG scope (there is no team to
  // stand in yet), so the chooser only offers it where the user's org role actually grants it —
  // the same rule `POST /org/organisations/:orgId/teams` enforces, mirrored here so the UI cannot
  // invite a call that would 403. The org's team cap is NOT pre-checked; `/auth/create-team`
  // enforces it.
  const creatableOrgs: WorkspaceChoiceCreatableOrg[] = orgRows
    .filter((row) => configRoleHoldsCapability(params.config, 'org', row.role, 'teams.manage'))
    .map((row) => ({ orgId: row.orgId, orgName: row.org.name }));

  return {
    teams,
    pending_invites: pendingInvites,
    can_create_org: Boolean(params.config.org_features?.allow_user_create_org),
    creatable_orgs: creatableOrgs,
  };
}
