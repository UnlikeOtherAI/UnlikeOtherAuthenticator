import { requireIdentityEmail } from './entity-lifecycle.service.js';
import type { PrismaClient } from '@prisma/client';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';

import type { ClientConfig } from './config.service.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { avatarImageBaseUrl, publicTeamAvatarImageUrl } from '../utils/avatar-url.js';
import { configRoleHoldsCapability } from './role-grants.js';
import { resolveInviterLabel } from './invite-inviter-label.service.js';
import {
  pendingInviteWhereForCaller,
} from './pending-invite-scope.service.js';
import {
  resolveProductTeamPolicy,
  type ProductTeamPolicy,
  type ProductTeamPolicyPrisma,
} from './product-team-policy.service.js';

export type TeamChoiceTeam = {
  can_manage_sso?: boolean;
  teamId: string;
  orgId: string;
  name: string;
  role: string;
  // Design §11.3 (gap-fix A Task 3) — matches `Auth/src/hooks/use-popup.tsx`'s `TeamChoice.iconUrl`.
  iconUrl: string | null;
  /**
   * Always-resolving team image (Docs/Auth/avatars.md §11.4), in the credential-free
   * `/teams/:teamId/avatar` form — the chooser renders in a popup that holds no bearer, so this is
   * the only avatar URL form it can put in an `<img src>`. Never null: uploaded → proxied
   * `iconUrl` → generated.
   */
  avatarImageUrl: string;
  /**
   * The owning organisation's name — two teams can share a name across different orgs (a
   * "General" in each), so the chooser needs the level above to tell them apart. Null only when a
   * caller supplied a team row without the org join; the query here always selects it.
   */
  orgName: string | null;
  // Gap-fix B Task 2 (design §11.4): lets the client match a `team_hint` deep-link param by slug as
  // well as by id — matches `Auth/src/hooks/use-popup.tsx`'s `TeamChoice.slug`.
  slug: string;
};

export type TeamChoicePendingInvite = {
  inviteId: string;
  teamName: string;
  /**
   * The inviting organisation's name — two organisations can each own a team called "General",
   * and the card carries no other organisation label. Null only for a caller that supplied an
   * invite row without the org join; the query here always selects it.
   */
  orgName: string | null;
  invitedBy: string | null;
};

/**
 * An organisation this user may add a further team (team) to from the chooser: they are an
 * ACTIVE owner/admin of it and the domain has opted in with `org_features.allow_user_create_team`.
 *
 * Deliberately distinct from `can_create_org`, which is about a user's *first* organisation
 * (brief §1718). An org is a level above a team: this list says "you may create a team
 * **here**", so the client can offer creation per organisation rather than as one ambiguous button
 * when the user belongs to several.
 */
export type TeamChoiceCreatableOrg = {
  orgId: string;
  orgName: string;
};

export type SessionChoices = {
  manageable_orgs?: TeamChoiceCreatableOrg[];
  teams: TeamChoiceTeam[];
  pending_invites: TeamChoicePendingInvite[];
  can_create_org: boolean;
  creatable_orgs: TeamChoiceCreatableOrg[];
};

export type AutoSelectedTeam = {
  orgId: string;
  teamId: string;
};

/**
 * `team_selection: "auto"` skips the chooser only when there is exactly one unambiguous
 * ACTIVE team and no pending invite. The skipped chooser is still a team selection:
 * callers must bind this exact org/team to the authorization code (and any intervening 2FA
 * bridge), just as `/auth/select-team` does for an explicit click.
 */
export function resolveAutoSelectedTeam(
  choices: SessionChoices,
): AutoSelectedTeam | null {
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
 * with `can_create_org` is the create-team entrypoint, not an unscoped-login fallback.
 */
export function shouldPresentTeamChooser(
  choices: SessionChoices,
  autoSelectedTeam = resolveAutoSelectedTeam(choices),
): boolean {
  return (
    !autoSelectedTeam &&
    (choices.teams.length >= 2 || choices.pending_invites.length > 0 || choices.can_create_org)
  );
}

type TeamChooserPrisma = {
  // `findMany` resolves the inviting user for member-initiated invitations, which record the
  // inviter as an id alone (`invite-inviter-label.service.ts`).
  user: Pick<PrismaClient['user'], 'findUnique' | 'findMany'>;
  orgMember: Pick<PrismaClient['orgMember'], 'findMany'>;
  teamMember: Pick<PrismaClient['teamMember'], 'findMany'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findMany'>;
};

/**
 * Phase 3b (design §4.3): the post-verification team chooser payload. Only ever built AFTER
 * identity verification (a successful /auth/verify-code or a valid login_token) — never before, so
 * it never leaks team names or membership existence to an unverified caller. Only ACTIVE team
 * memberships are listed; DEACTIVATED/REMOVED rows are silently omitted (design §8: a suspended user
 * never sees "you were suspended", the team just isn't there).
 */
export async function buildSessionChoices(
  params: {
    userId: string;
    config: ClientConfig;
    authenticationEvidenceId?: string;
  },
  deps?: {
    policy?: ProductTeamPolicy;
    policyPrisma?: ProductTeamPolicyPrisma;
    crossProductPrisma?: TeamChooserPrisma;
    prisma?: TeamChooserPrisma;
    now?: () => Date;
  },
): Promise<SessionChoices> {
  const prisma = deps?.prisma ?? (getPrisma() as unknown as TeamChooserPrisma);
  const now = deps?.now ? deps.now() : new Date();
  let allowedOrgId: string | undefined;
  if (params.authenticationEvidenceId) {
    const authority = (deps?.crossProductPrisma ?? prisma) as PrismaClient;
    const principal = await authority.user.findUnique({ where: { id: params.userId }, select: { tokenVersion: true } });
    const evidence = await requireAuthenticationEvidence({ id: params.authenticationEvidenceId, userId: params.userId,
      credentialEpoch: principal?.tokenVersion ?? -1, clientDomain: params.config.domain }, authority);
    if (evidence.provenance !== 'independent') allowedOrgId = evidence.orgId ?? undefined;
  }

  const user = await prisma.user.findUnique({
    where: { lifecycleStatus: 'ACTIVE', id: params.userId },
    select: { email: true },
  });
  if (!user || !user.email) {
    return { teams: [], pending_invites: [], can_create_org: false, creatable_orgs: [] };
  }

  const domain = params.config.domain.trim().toLowerCase().replace(/\.$/, '');
  const policy =
    deps?.policy ??
    (await resolveProductTeamPolicy(
      { domain },
      {
        now: deps?.now,
        prisma: deps?.policyPrisma ?? (getAdminPrisma() as unknown as ProductTeamPolicyPrisma),
      },
    ));

  // An org is the level above a team: this decides which organisations the user may add a
  // team TO. Only queried when the domain has opted in — otherwise the chooser offers no
  // creation and the read would be dead weight on every login.
  const canCreateTeams = Boolean(
    !allowedOrgId && params.config.org_features?.enabled && params.config.org_features.allow_user_create_team,
  );

  const [sameDomainTeamRows, inviteRows, orgRows] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: { ...(allowedOrgId ? { orgId: allowedOrgId } : {}), org: { domain } },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { name: true, slug: true, orgId: true, iconUrl: true, org: { select: { name: true, ownerId: true } } } },
      },
    }),
    allowedOrgId ? Promise.resolve([]) : prisma.teamInvite.findMany({
      // Exactly the sidebar's filter (`pending-invite-scope.service.ts`): eligibility, this
      // caller's own address, and the product's organisation reach. The chooser used to be
      // domain-scoped while `/org/me` spanned the policy's organisations, so an
      // `all_active_memberships` product could be offered an invitation in one surface and not
      // the other. This read stays on the caller-supplied client: `/auth/select-team` rebuilds
      // the payload inside the transaction that just accepted or declined an invitation, and a
      // separate connection would not see that yet.
      where: pendingInviteWhereForCaller({
        email: requireIdentityEmail(user.email),
        userId: params.userId,
        domain,
        policy,
        now,
      }),
      select: {
        id: true,
        team: { select: { name: true } },
        org: { select: { name: true } },
        invitedByName: true,
        invitedByUserId: true,
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
      deps?.crossProductPrisma ?? (getAdminPrisma() as unknown as TeamChooserPrisma);
    productTeamRows = await crossProductPrisma.teamMember.findMany({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: {
          ...(allowedOrgId ? { orgId: allowedOrgId } : {}),
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
        team: { select: { name: true, slug: true, orgId: true, iconUrl: true, org: { select: { name: true, ownerId: true } } } },
      },
    });
  }

  const teamRows = [
    ...new Map(
      [...sameDomainTeamRows, ...productTeamRows].map((row) => [row.teamId, row]),
    ).values(),
  ];

  const avatarBaseUrl = avatarImageBaseUrl();
  const teams: TeamChoiceTeam[] = teamRows.map((row) => ({
    teamId: row.teamId,
    orgId: row.team.orgId,
    name: row.team.name,
    role: row.teamRole,
    iconUrl: row.team.iconUrl,
    avatarImageUrl: publicTeamAvatarImageUrl({ baseUrl: avatarBaseUrl, teamId: row.teamId }),
    orgName: row.team.org?.name ?? null,
    slug: row.team.slug,
    ...(!allowedOrgId && row.team.org?.ownerId === params.userId ? { can_manage_sso: true } : {}),
  }));

  // Member-initiated invitations record only `invitedByUserId` — resolve those inviters.
  const invitedBy = await resolveInviterLabel(inviteRows, { prisma });
  const pendingInvites: TeamChoicePendingInvite[] = inviteRows.map((row) => ({
    inviteId: row.id,
    teamName: row.team.name,
    orgName: row.org?.name ?? null,
    invitedBy: invitedBy(row),
  }));

  // Creating a team inside an org needs `teams.manage` at ORG scope (there is no team to
  // stand in yet), so the chooser only offers it where the user's org role actually grants it —
  // the same rule `POST /org/organisations/:orgId/teams` enforces, mirrored here so the UI cannot
  // invite a call that would 403. The org's team cap is NOT pre-checked; `/auth/create-team`
  // enforces it.
  const creatableOrgs: TeamChoiceCreatableOrg[] = orgRows
    .filter((row) => configRoleHoldsCapability(params.config, 'org', row.role, 'teams.manage'))
    .map((row) => ({ orgId: row.orgId, orgName: row.org.name }));

  const manageableOrgs = allowedOrgId ? [] : await (deps?.crossProductPrisma ?? prisma).orgMember.findMany({
    where: { userId: params.userId, status: 'ACTIVE', org: { ownerId: params.userId, lifecycleStatus: 'ACTIVE',
      ...(policy.scope === 'all_active_memberships' ? {} : { domain }) } },
    select: { orgId: true, org: { select: { name: true } } },
  });

  return {
    teams,
    pending_invites: pendingInvites,
    ...(manageableOrgs.length ? { manageable_orgs: manageableOrgs.map((m) => ({ orgId: m.orgId, orgName: m.org.name })) } : {}),
    can_create_org: !allowedOrgId && Boolean(params.config.org_features?.allow_user_create_org),
    creatable_orgs: creatableOrgs,
  };
}
