import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { isOrgOrTeamManager } from './team.service.base.js';
import { pendingInviteStatusWhere } from './first-login.service.js';
import {
  TEAM_INVITE_SELECT,
  toInviteRecord,
  type InviteApprovalStatusValue,
  type InviteDeps,
  type InvitePrisma,
} from './team-invite.service.base.js';

export type TeamInvitedEntry = {
  inviteId: string;
  email: string;
  inviteName: string | null;
  teamRole: string;
  invitedByName: string | null;
  invitedByEmail: string | null;
  lastSentAt: Date;
  expiresAt: Date | null;
  approvalStatus: InviteApprovalStatusValue;
  openCount: number;
};

/**
 * Gap-fix A Task 2 (design §11.4 "Invited" tab): pending invites for a single team, for the
 * `?include=invited` addendum on `GET /org/organisations/:orgId/teams/:teamId`. Gated to org/team
 * owner/admin — invite emails are PII — a plain member gets `[]` back (never a 403; the rest of the
 * team read must stay unaffected). Unlike the sidebar/chooser eligibility filter (Task 1's
 * `pendingInviteStatusWhere({ includePendingApproval: false })`), this INCLUDES
 * `approvalStatus: 'pending'` entries: an admin reviewing the Invited tab must see invites still
 * awaiting member-invite approval, distinguished by that same field.
 */
export async function getTeamInvitedEntries(
  params: { orgId: string; teamId: string; actorUserId: string },
  deps?: InviteDeps,
): Promise<TeamInvitedEntry[]> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return [];

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const isManager = await isOrgOrTeamManager(prisma, params);
  if (!isManager) return [];

  const now = deps?.now ? deps.now() : new Date();
  const rows = await prisma.teamInvite.findMany({
    where: {
      orgId: params.orgId,
      teamId: params.teamId,
      ...pendingInviteStatusWhere({ now, includePendingApproval: true }),
    },
    orderBy: { createdAt: 'desc' },
    select: TEAM_INVITE_SELECT,
  });

  return rows.map((row) => {
    const record = toInviteRecord(row, now);
    return {
      inviteId: record.id,
      email: record.email,
      inviteName: record.inviteName,
      teamRole: record.teamRole,
      invitedByName: record.invitedByName,
      invitedByEmail: record.invitedByEmail,
      lastSentAt: record.lastSentAt,
      expiresAt: record.expiresAt,
      approvalStatus: record.approvalStatus,
      openCount: record.openCount,
    };
  });
}
