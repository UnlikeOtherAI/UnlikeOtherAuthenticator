import type { Prisma } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { AppError } from '../utils/errors.js';
import { ensureOrgRole, parseOrgFeatureRoles, parseOrgLimit } from './organisation.service.base.js';
import {
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
} from './team.service.base.js';
import {
  writeOrgAuditLog,
  type OrgAuditLogPrisma,
  type WriteOrgAuditLogParams,
} from './org-audit-log.service.js';
import { assertTeamInviteTransition, isExpired } from './team-invite-state-machine.js';
import {
  assertActiveTeamMembership,
  lockAndAssertActiveTeamMembership,
  lockTeamMembershipRows,
} from './team-scope.service.js';

/**
 * Reactivation audit rows are written inside the acceptance transaction, so a later rollback in
 * the caller (token consumption, team-scope policy, 2FA) never leaves a row for a reactivation that
 * did not happen. That is RLS-safe on every caller: they run either on the BYPASSRLS admin client
 * or in a tenant transaction scoped to the invite's organisation, and `org_audit_log_insert`
 * checks the same `org_id = app.org_id` predicate `org_members_update` already had to pass.
 */
async function writeInviteAuditLog(
  prisma: Prisma.TransactionClient,
  entry: Omit<WriteOrgAuditLogParams, 'actor'>,
): Promise<void> {
  await writeOrgAuditLog(entry, { prisma: prisma as unknown as OrgAuditLogPrisma });
}

export async function acceptTeamInviteWithinTransaction(params: {
  prisma: Prisma.TransactionClient;
  teamInviteId: string;
  userId: string;
  config: ClientConfig;
  now: Date;
}): Promise<{ orgId: string; teamId: string }> {
  const invite = await params.prisma.teamInvite.findUnique({
    where: { id: params.teamInviteId },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      inviteName: true,
      teamRole: true,
      acceptedUserId: true,
      acceptedAt: true,
      declinedAt: true,
      revokedAt: true,
      expiresAt: true,
      approvalStatus: true,
      org: {
        select: {
          id: true,
          domain: true,
        },
      },
    },
  });

  if (!invite) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (invite.revokedAt) {
    throw new AppError('BAD_REQUEST', 400, 'INVITE_INVALID');
  }

  // The invite's org may have been created by another UOA-integrated product: one organisation is
  // usable from every product, so the org's ORIGIN domain is not an acceptance predicate. What
  // binds the acceptance is the invite token itself — issued for, and verified against, the
  // issuing product's domain — plus the team-scope gate below.

  if (invite.acceptedAt) {
    if (invite.acceptedUserId === params.userId) {
      await lockAndAssertActiveTeamMembership(
        {
          userId: params.userId,
          orgId: invite.orgId,
          teamId: invite.teamId,
        },
        { prisma: params.prisma },
      );
      return { orgId: invite.orgId, teamId: invite.teamId };
    }
    throw new AppError('BAD_REQUEST', 400);
  }

  if (
    isExpired(invite, params.now) &&
    (invite.approvalStatus === 'NOT_REQUIRED' || invite.approvalStatus === 'APPROVED')
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVITE_EXPIRED');
  }

  // Declined or unapproved invitations remain the same generic invalid result. The shared state
  // machine keeps this transition aligned with decline/resend/revoke by construction.
  assertTeamInviteTransition({ transition: 'accept', invite, now: params.now });

  const user = await params.prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError('BAD_REQUEST', 400);
  }

  // The inviter's guess at a name only fills a gap. Guard the write on the blank name rather
  // than on the value read above: `POST /auth/verify-email` may commit a name the person typed
  // themselves between that read and this write, and check-then-act would overwrite it.
  if (!user.name && invite.inviteName) {
    await params.prisma.user.updateMany({
      where: { id: params.userId, OR: [{ name: null }, { name: '' }] },
      data: { name: invite.inviteName },
    });
  }

  ensureOrgRole('member', parseOrgFeatureRoles(params.config));
  await lockTeamMembershipRows(
    {
      userId: params.userId,
      orgId: invite.orgId,
      teamId: invite.teamId,
    },
    { prisma: params.prisma },
  );

  const existingMembershipInOrganisation = await params.prisma.orgMember.findFirst({
    where: {
      userId: params.userId,
      orgId: invite.orgId,
    },
    select: {
      id: true,
      orgId: true,
      role: true,
      status: true,
    },
  });
  const existingTeamMembership = await params.prisma.teamMember.findFirst({
    where: {
      teamId: invite.teamId,
      userId: params.userId,
    },
    select: { id: true, status: true },
  });

  // DEACTIVATED is an administrative suspension (design §4.1/§4.5): only
  // `POST .../members/:userId/reactivate` lifts it, and an invitation is not that
  // decision. REMOVED is a tombstone of a past membership, and a fresh, valid
  // invitation is exactly the re-add that design §4.1 says flips it back to ACTIVE.
  if (
    existingMembershipInOrganisation?.status === 'DEACTIVATED' ||
    existingTeamMembership?.status === 'DEACTIVATED'
  ) {
    throw new AppError('BAD_REQUEST', 400, 'MEMBERSHIP_DEACTIVATED');
  }

  // Limits count ACTIVE rows, like every other add path: a tombstone is not a membership, and a
  // reactivated row consumes a seat exactly as a newly created one does.
  if (!existingMembershipInOrganisation || existingMembershipInOrganisation.status === 'REMOVED') {
    const memberCount = await params.prisma.orgMember.count({
      where: { orgId: invite.orgId, status: 'ACTIVE' },
    });
    if (memberCount >= parseOrgLimit(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }
  }

  if (!existingMembershipInOrganisation) {
    await params.prisma.orgMember.create({
      data: {
        orgId: invite.orgId,
        userId: params.userId,
        role: 'member',
      },
      select: { id: true },
    });
  } else if (existingMembershipInOrganisation.status === 'REMOVED') {
    // The invitation grants the default member role. A role held before removal (admin, owner,
    // a custom role) is never silently restored; an owner re-grants it deliberately.
    await params.prisma.orgMember.update({
      where: { id: existingMembershipInOrganisation.id },
      data: { role: 'member', status: 'ACTIVE', statusChangedAt: params.now },
      select: { id: true },
    });
    await writeInviteAuditLog(params.prisma, {
      orgId: invite.orgId,
      actorUserId: params.userId,
      action: 'member.reactivated',
      targetType: 'org_member',
      targetId: existingMembershipInOrganisation.id,
      metadata: {
        userId: params.userId,
        role: 'member',
        previousRole: existingMembershipInOrganisation.role,
        previousStatus: 'REMOVED',
        via: 'invite',
        inviteId: invite.id,
      },
    });
  }

  if (!existingTeamMembership || existingTeamMembership.status === 'REMOVED') {
    const teamMemberCount = await params.prisma.teamMember.count({
      where: { teamId: invite.teamId, status: 'ACTIVE' },
    });
    if (teamMemberCount >= parseMaxMembersPerTeam(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const userMembershipCount = await params.prisma.teamMember.count({
      where: {
        userId: params.userId,
        status: 'ACTIVE',
        team: {
          orgId: invite.orgId,
        },
      },
    });
    if (userMembershipCount >= parseMaxTeamMembershipsPerUser(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }
  }

  const teamRole = normalizeTeamRole(invite.teamRole, params.config);
  if (!existingTeamMembership) {
    await params.prisma.teamMember.create({
      data: {
        teamId: invite.teamId,
        userId: params.userId,
        teamRole,
      },
      select: { id: true },
    });
  } else if (existingTeamMembership.status === 'REMOVED') {
    await params.prisma.teamMember.update({
      where: { id: existingTeamMembership.id },
      data: { teamRole, status: 'ACTIVE', statusChangedAt: params.now },
      select: { id: true },
    });
    await writeInviteAuditLog(params.prisma, {
      orgId: invite.orgId,
      actorUserId: params.userId,
      action: 'team_member.added',
      targetType: 'team_member',
      targetId: existingTeamMembership.id,
      metadata: {
        teamId: invite.teamId,
        userId: params.userId,
        teamRole,
        via: 'invite',
        reactivated: true,
        inviteId: invite.id,
      },
    });
  }

  // Every row is now ACTIVE or the call has already refused; this re-reads the committed state
  // under the locks taken above so a concurrent lifecycle write cannot slip between.
  // An ACTIVE row keeps its existing role — accepting an invite never overwrites it.
  //
  // Deliberately domain-agnostic, because the paragraph at the top of this
  // function is only true if it is: an organisation founded through one product
  // and invited into through another has no membership row on the inviting
  // product's domain, so a domain-scoped assertion refused every such
  // acceptance with a bare 401. The invitation itself is the authority here —
  // minted for, and verified against, the issuing product's domain — and the
  // ACTIVE requirement above is what this call still enforces.
  await assertActiveTeamMembership(
    {
      userId: params.userId,
      orgId: invite.orgId,
      teamId: invite.teamId,
    },
    { prisma: params.prisma },
  );

  await params.prisma.teamInvite.update({
    where: { id: invite.id },
    data: {
      acceptedAt: params.now,
      acceptedUserId: params.userId,
    },
    select: { id: true },
  });

  return { orgId: invite.orgId, teamId: invite.teamId };
}

/**
 * Phase 3b (design §4.3/§11.5): decline a pending invite from the team chooser, authenticated
 * by an already-verified userId (the login_token bridge) rather than the emailed invite token used
 * by `declineTeamInviteByToken`. Generic `BAD_REQUEST` on every validation failure (unknown invite,
 * invite already resolved, email mismatch) — no oracle on invite existence.
 */
export async function declineTeamInviteForUser(params: {
  prisma: Prisma.TransactionClient;
  teamInviteId: string;
  userId: string;
  config: ClientConfig;
  now: Date;
}): Promise<void> {
  const invite = await params.prisma.teamInvite.findUnique({
    where: { id: params.teamInviteId },
    select: {
      id: true,
      email: true,
      acceptedAt: true,
      declinedAt: true,
      revokedAt: true,
      expiresAt: true,
      approvalStatus: true,
    },
  });

  if (!invite || invite.revokedAt || invite.acceptedAt) {
    throw new AppError('BAD_REQUEST', 400);
  }

  // The invite's org may have been created by another UOA-integrated product: one organisation is
  // usable from every product, so the org's ORIGIN domain is not a predicate here. Declining is
  // bound by the invitee's own identity — the email match below against the already-verified
  // userId — which is the only thing that ever made this call the invitee's to make.

  const user = await params.prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (invite.declinedAt) {
    // Idempotent: declining an already-declined invite is a success with no second write.
    return;
  }

  // Everything the shared policy still refuses at this point — in practice a DENIED invite, which
  // `pendingInviteStatusWhere` never surfaces to an invitee, so this is a floor rather than a gate.
  assertTeamInviteTransition({ transition: 'decline', invite, now: params.now });

  await params.prisma.teamInvite.update({
    where: { id: invite.id },
    data: { declinedAt: params.now },
    select: { id: true },
  });
}
