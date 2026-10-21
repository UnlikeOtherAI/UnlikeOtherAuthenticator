import { requireIdentityEmail } from './entity-lifecycle.service.js';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import {
  pendingInviteStatusWhere,
} from './pending-invite-scope.service.js';
import {
  resolveProductTeamPolicy,
  type ProductTeamPolicy,
  type ProductTeamPolicyPrisma,
} from './product-team-policy.service.js';

type FirstLoginPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
  orgMember: Pick<PrismaClient['orgMember'], 'findMany'>;
  teamMember: Pick<PrismaClient['teamMember'], 'findMany'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findMany'>;
};

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
    policy?: ProductTeamPolicy;
    policyPrisma?: ProductTeamPolicyPrisma;
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
    where: { lifecycleStatus: 'ACTIVE', id: params.userId },
    select: { email: true },
  });
  if (!user || !user.email) {
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
        email: requireIdentityEmail(user.email),
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
      resolveProductTeamPolicy(
        { domain },
        {
          now: deps?.now,
          prisma:
            deps?.policyPrisma ?? (getAdminPrisma() as unknown as ProductTeamPolicyPrisma),
        },
      ),
  ]);

  let productOrgRows: typeof sameDomainOrgRows = [];
  let productTeamRows: typeof sameDomainTeamRows = [];
  if (policy.scope === 'all_active_memberships') {
    // Product team expansion is a pre-auth, cross-tenant operation. It is
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

export { buildSessionChoices, resolveAutoSelectedTeam, shouldPresentTeamChooser } from './session-choices.service.js';
export type { TeamChoiceTeam, TeamChoicePendingInvite, TeamChoiceCreatableOrg, SessionChoices, AutoSelectedTeam } from './session-choices.service.js';
