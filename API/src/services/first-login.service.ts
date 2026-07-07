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
        team: { select: { orgId: true } },
      },
    }),
    prisma.teamInvite.findMany({
      where: {
        email: user.email,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        // Task 3/4 (design §4.7): expired invites and invites awaiting member-invite approval are
        // not yet real pending invites for the invitee — excluded from every pending-invite surface.
        approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
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

export type WorkspaceChoiceTeam = {
  teamId: string;
  orgId: string;
  name: string;
  role: string;
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
        team: { select: { name: true, orgId: true } },
      },
    }),
    prisma.teamInvite.findMany({
      where: {
        email: user.email,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        // Task 3/4 (design §4.7): expired invites and invites awaiting member-invite approval are
        // not yet real pending invites for the invitee — excluded from the chooser.
        approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        org: { domain },
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
