import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { selectRedirectUrl } from './authorization-code.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { sendTeamInviteEmail } from './email.service.js';
import {
  assertDatabaseEnabled,
  auditOrg,
  getOrganisationMember,
  resolveOrganisationByDomain,
} from './organisation.service.base.js';
import { normalizeTeamRole } from './team.service.base.js';
import { buildUserIdentity } from './user-scope.service.js';
import {
  TEAM_INVITE_SELECT,
  computeInviteExpiresAt,
  type InviteDeps,
  type TeamInviteRecord,
  buildTeamInviteLink,
  buildTeamInviteTrackingPixelUrl,
  getEnv,
  hashEmailToken,
  issueInviteToken,
  normalizeEmail,
  normalizeInviteName,
  resolveBaseUrl,
  resolveInviteTarget,
  toInviteRecord,
  type InvitePrisma,
} from './team-invite.service.base.js';

// Phase 4 Task 4 (design §4.7): member-initiated invites + the owner/admin approval workflow. Split
// out of team-invite.service.management.ts (which was already at the 500-line cap before this task)
// so the permission matrix and the approve/deny flow have their own home, mirroring the existing
// base/token/acceptance/management/resend slicing.

type MemberInvitesSetting = 'allowed' | 'admin_approval' | 'disabled';

function normalizeMemberInvitesSetting(value: string | undefined): MemberInvitesSetting {
  if (value === 'admin_approval' || value === 'disabled') return value;
  return 'allowed';
}

/**
 * Member-initiated invite (user-token variant of the backend bulk-invite endpoint, same route).
 * Permission (design §4.7):
 *   - org OR team owner/admin: always allowed, `approvalStatus: NOT_REQUIRED`, email sent immediately.
 *   - plain ACTIVE team member: gated by the org's `memberInvites` setting —
 *       "allowed" -> NOT_REQUIRED, sent immediately
 *       "admin_approval" -> PENDING, requestedByUserId recorded, NO email sent yet
 *       "disabled" -> rejected
 *   - a deactivated/non-member actor is rejected (Phase 2 `activeOnly` actor rule).
 * The HTTP response is intentionally the same shape regardless of whether the email already has an
 * account, is already a member, or belongs to a user in a conflicting org — no email enumeration.
 */
export async function createMemberInvite(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    config: ClientConfig;
    configUrl: string;
    actorUserId: string;
    redirectUrl?: string;
    invite: { email: string; name?: string; teamRole?: string };
  },
  deps?: InviteDeps & { sendTeamInviteEmail?: typeof sendTeamInviteEmail },
): Promise<{ status: 'ok' }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendInviteEmail = deps?.sendTeamInviteEmail ?? sendTeamInviteEmail;

  const { org, team } = await resolveInviteTarget({
    prisma,
    orgId: params.orgId,
    teamId: params.teamId,
    domain: params.domain,
  });

  const redirectUrl = params.redirectUrl
    ? selectRedirectUrl({
        allowedRedirectUrls: params.config.redirect_urls,
        requestedRedirectUrl: params.redirectUrl,
      })
    : undefined;

  const actorOrgMembership = await getOrganisationMember(
    prisma,
    { orgId: org.id, userId: params.actorUserId },
    { activeOnly: true },
  );
  if (!actorOrgMembership) {
    // Not an active org member (or deactivated) — generic, no distinction from any other 403.
    throw new AppError('FORBIDDEN', 403);
  }

  let approvalStatus: 'NOT_REQUIRED' | 'PENDING' = 'NOT_REQUIRED';
  const isOrgManager = actorOrgMembership.role === 'owner' || actorOrgMembership.role === 'admin';

  if (!isOrgManager) {
    const actorTeamMembership = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: params.actorUserId, status: 'ACTIVE' },
      select: { teamRole: true },
    });
    const isTeamManager =
      actorTeamMembership?.teamRole === 'owner' || actorTeamMembership?.teamRole === 'admin';

    if (!isTeamManager) {
      if (!actorTeamMembership) {
        throw new AppError('FORBIDDEN', 403);
      }

      const setting = normalizeMemberInvitesSetting(org.memberInvites);

      if (setting === 'disabled') {
        throw new AppError('FORBIDDEN', 403);
      }
      if (setting === 'admin_approval') {
        approvalStatus = 'PENDING';
      }
    }
  }

  const email = normalizeEmail(params.invite.email);
  const inviteName = normalizeInviteName(params.invite.name);
  const teamRole = normalizeTeamRole(params.invite.teamRole);

  const identity = buildUserIdentity({
    userScope: params.config.user_scope,
    email,
    domain: params.config.domain,
  });
  const existingUser = await prisma.user.findUnique({
    where: { userKey: identity.userKey },
    select: { id: true, tokenVersion: true },
  });

  if (existingUser) {
    const existingTeamMembership = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: existingUser.id },
      select: { id: true },
    });
    if (existingTeamMembership) {
      // Already a member — no invite to create, but the response must not say so.
      return { status: 'ok' };
    }

    const existingDomainMembership = await prisma.orgMember.findFirst({
      where: { userId: existingUser.id, org: { domain: org.domain } },
      select: { orgId: true },
    });
    if (existingDomainMembership && existingDomainMembership.orgId !== org.id) {
      return { status: 'ok' };
    }

    if (params.config.existing_user_registration_behavior === 'inline_sign_in') {
      return { status: 'ok' };
    }
  }

  const existingInvite = await prisma.teamInvite.findFirst({
    where: { teamId: team.id, email },
    orderBy: { createdAt: 'desc' },
    select: { id: true, acceptedAt: true, declinedAt: true, revokedAt: true },
  });
  if (
    existingInvite &&
    !existingInvite.acceptedAt &&
    !existingInvite.declinedAt &&
    !existingInvite.revokedAt
  ) {
    await prisma.teamInvite.updateMany({
      where: { teamId: team.id, email, acceptedAt: null, declinedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  const invite = await prisma.teamInvite.create({
    data: {
      orgId: org.id,
      teamId: team.id,
      email,
      inviteName,
      teamRole,
      redirectUrl: redirectUrl ?? null,
      invitedByUserId: params.actorUserId,
      requestedByUserId: approvalStatus === 'PENDING' ? params.actorUserId : null,
      approvalStatus,
      lastSentAt: now,
      expiresAt: computeInviteExpiresAt(now),
    },
    select: TEAM_INVITE_SELECT,
  });

  if (approvalStatus === 'NOT_REQUIRED') {
    const token = await issueInviteToken({
      prisma,
      inviteId: invite.id,
      existingUser,
      email,
      userKey: identity.userKey,
      domain: identity.domain,
      config: params.config,
      configUrl: params.configUrl,
      now,
      sharedSecret: deps?.sharedSecret,
      generateEmailTokenFn: deps?.generateEmailToken,
      hashEmailTokenFn: deps?.hashEmailToken ?? hashEmailToken,
    });

    const link = buildTeamInviteLink({
      baseUrl: resolveBaseUrl(env),
      token,
      configUrl: params.configUrl,
      redirectUrl,
    });

    await sendInviteEmail({
      to: email,
      link,
      trackingPixelUrl: buildTeamInviteTrackingPixelUrl({
        baseUrl: resolveBaseUrl(env),
        inviteId: invite.id,
      }),
      organisationName: org.name,
      teamName: team.name,
      inviteeName: inviteName ?? undefined,
      theme: extractEmailTheme(params.config),
    });
  }

  await auditOrg({
    orgId: org.id,
    actorUserId: params.actorUserId,
    action: 'invite.created',
    targetType: 'invite',
    targetId: invite.id,
    metadata: { teamId: team.id, approvalStatus },
  });

  return { status: 'ok' };
}

async function findOrgInviteOrThrow(params: {
  prisma: InvitePrisma;
  orgId: string;
  inviteId: string;
}) {
  const invite = await params.prisma.teamInvite.findFirst({
    where: { id: params.inviteId, orgId: params.orgId },
    select: {
      ...TEAM_INVITE_SELECT,
      team: { select: { id: true, name: true } },
      org: { select: { name: true, domain: true } },
    },
  });
  if (!invite) {
    throw new AppError('NOT_FOUND', 404);
  }
  return invite;
}

/** `GET /org/organisations/:orgId/invitations?approval=pending` — owner/admin only. */
export async function listPendingApprovalInvites(
  params: { orgId: string; domain: string },
  deps?: InviteDeps,
): Promise<{ data: TeamInviteRecord[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  const rows = await prisma.teamInvite.findMany({
    where: { orgId: org.id, approvalStatus: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: TEAM_INVITE_SELECT,
  });

  const now = deps?.now ? deps.now() : new Date();
  return { data: rows.map((row) => toInviteRecord(row, now)) };
}

/** `POST /org/organisations/:orgId/invitations/:inviteId/approve` — owner/admin only. */
export async function approveInvite(
  params: {
    orgId: string;
    domain: string;
    inviteId: string;
    config: ClientConfig;
    configUrl: string;
    reviewerUserId: string;
  },
  deps?: InviteDeps & { sendTeamInviteEmail?: typeof sendTeamInviteEmail },
): Promise<TeamInviteRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendInviteEmail = deps?.sendTeamInviteEmail ?? sendTeamInviteEmail;

  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });
  const invite = await findOrgInviteOrThrow({ prisma, orgId: org.id, inviteId: params.inviteId });

  if (invite.approvalStatus !== 'PENDING') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const identity = buildUserIdentity({
    userScope: params.config.user_scope,
    email: invite.email,
    domain: params.config.domain,
  });
  const existingUser = await prisma.user.findUnique({
    where: { userKey: identity.userKey },
    select: { id: true, tokenVersion: true },
  });

  const updated = await prisma.teamInvite.update({
    where: { id: invite.id },
    data: { approvalStatus: 'APPROVED' },
    select: TEAM_INVITE_SELECT,
  });

  const token = await issueInviteToken({
    prisma,
    inviteId: updated.id,
    existingUser,
    email: updated.email,
    userKey: identity.userKey,
    domain: identity.domain,
    config: params.config,
    configUrl: params.configUrl,
    now,
    sharedSecret: deps?.sharedSecret,
    generateEmailTokenFn: deps?.generateEmailToken,
    hashEmailTokenFn: deps?.hashEmailToken ?? hashEmailToken,
  });

  const link = buildTeamInviteLink({
    baseUrl: resolveBaseUrl(env),
    token,
    configUrl: params.configUrl,
    redirectUrl: updated.redirectUrl ?? undefined,
  });

  await sendInviteEmail({
    to: updated.email,
    link,
    trackingPixelUrl: buildTeamInviteTrackingPixelUrl({
      baseUrl: resolveBaseUrl(env),
      inviteId: updated.id,
    }),
    organisationName: invite.org.name,
    teamName: invite.team.name,
    inviteeName: updated.inviteName ?? undefined,
    theme: extractEmailTheme(params.config),
  });

  await auditOrg({
    orgId: org.id,
    actorUserId: params.reviewerUserId,
    action: 'invite.approved',
    targetType: 'invite',
    targetId: updated.id,
    metadata: { teamId: invite.team.id },
  });

  return toInviteRecord(updated, now);
}

/** `POST /org/organisations/:orgId/invitations/:inviteId/deny` — owner/admin only; silent to the invitee. */
export async function denyInvite(
  params: { orgId: string; domain: string; inviteId: string; reviewerUserId: string },
  deps?: InviteDeps,
): Promise<TeamInviteRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();

  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });
  const invite = await findOrgInviteOrThrow({ prisma, orgId: org.id, inviteId: params.inviteId });

  if (invite.approvalStatus !== 'PENDING') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const updated = await prisma.teamInvite.update({
    where: { id: invite.id },
    data: { approvalStatus: 'DENIED' },
    select: TEAM_INVITE_SELECT,
  });

  await auditOrg({
    orgId: org.id,
    actorUserId: params.reviewerUserId,
    action: 'invite.denied',
    targetType: 'invite',
    targetId: updated.id,
    metadata: { teamId: invite.team.id },
  });

  return toInviteRecord(updated, now);
}
