import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getPrisma } from '../db/prisma.js';

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
  deps?: { prisma?: FirstLoginPrisma },
): Promise<FirstLoginBlock | null> {
  if (!params.config.org_features?.enabled) {
    return null;
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as FirstLoginPrisma);

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
        team: { org: { domain } },
      },
      select: {
        teamId: true,
        teamRole: true,
        team: { select: { orgId: true } },
      },
    }),
    prisma.teamInvite.findMany({
      where: {
        email: user.email,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        org: { domain },
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
