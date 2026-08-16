import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { selectRedirectUrl } from './authorization-code.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { sendTeamInviteEmail } from './email.service.js';
import {
  assertDatabaseEnabled,
  auditOrg,
  type OrgActorProvenance,
  getOrganisationMember,
  resolveOrgActor,
  resolveOrganisationByDomain,
} from './organisation.service.base.js';
import { hasWorkspaceCapability } from './team.service.base.js';
import { buildUserIdentity } from './user-scope.service.js';
import {
  ACTIONABLE_TEAM_INVITE_WHERE,
  TEAM_INVITE_SELECT,
  computeInviteExpiresAt,
  normalizeInviteGrantRole,
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
import {
  assertTeamInviteTransition,
  decideTeamInviteTransition,
} from './team-invite-state-machine.js';

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
    actor?: OrgActorProvenance;
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
  // A manager invites outright; everyone else goes through the org's member-invite policy. This
  // used to inline its own `owner|admin` comparison at both scopes — the same predicate
  // `hasWorkspaceCapability` now owns, so a domain's configured roles decide it here too.
  const isManager = await hasWorkspaceCapability(prisma, 'members.manage', {
    orgId: org.id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    config: params.config,
  });

  if (!isManager) {
    const actorTeamMembership = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: params.actorUserId, status: 'ACTIVE' },
      select: { teamRole: true },
    });
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

  const email = normalizeEmail(params.invite.email);
  const inviteName = normalizeInviteName(params.invite.name);
  const teamRole = normalizeInviteGrantRole(params.invite.teamRole, params.config);

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

  // Only the one actionable invite counts as "existing"; replacing it frees the slot the partial
  // unique index guards, before the create below.
  const existingInvite = await prisma.teamInvite.findFirst({
    where: { ...ACTIONABLE_TEAM_INVITE_WHERE, teamId: team.id, email },
    orderBy: { createdAt: 'desc' },
    select: {
      acceptedAt: true,
      declinedAt: true,
      revokedAt: true,
      expiresAt: true,
      approvalStatus: true,
    },
  });
  const replacesExisting =
    decideTeamInviteTransition({ transition: 'create', invite: existingInvite, now }).kind ===
    'no-op';
  if (replacesExisting) {
    await prisma.teamInvite.updateMany({
      where: { ...ACTIONABLE_TEAM_INVITE_WHERE, teamId: team.id, email },
      data: { revokedAt: now, revokedReason: 'REPLACED' },
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
    actor: params.actor,
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

  // `approvalStatus: 'PENDING'` alone is not enough: a row can be revoked or declined while still
  // stamped PENDING, and an approver must not be shown work that no longer exists. The actionable
  // predicate is spread FIRST so the explicit PENDING below wins over its `not: 'DENIED'`, then an
  // expiry filter — an expired invite can no longer be approved, so listing it is a dead end.
  const now = deps?.now ? deps.now() : new Date();
  const rows = await prisma.teamInvite.findMany({
    where: {
      ...ACTIONABLE_TEAM_INVITE_WHERE,
      orgId: org.id,
      approvalStatus: 'PENDING',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    select: TEAM_INVITE_SELECT,
  });

  return { data: rows.map((row) => toInviteRecord(row, now, org.domain)) };
}

/** `POST /org/organisations/:orgId/invitations/:inviteId/approve` — owner/admin only. */
export async function approveInvite(
  params: {
    orgId: string;
    domain: string;
    inviteId: string;
    config: ClientConfig;
    configUrl: string;
    /** Absent in backend mode: nobody reviewed it, the backend decided. */
    reviewerUserId?: string;
    actor?: OrgActorProvenance;
  },
  deps?: InviteDeps & { sendTeamInviteEmail?: typeof sendTeamInviteEmail },
): Promise<TeamInviteRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  // Reject a call that names neither a reviewer nor a backend rather than
  // silently writing an unattributed approval.
  const reviewerUserId = resolveOrgActor({ actorUserId: params.reviewerUserId, actor: params.actor });
  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendInviteEmail = deps?.sendTeamInviteEmail ?? sendTeamInviteEmail;

  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });
  const invite = await findOrgInviteOrThrow({ prisma, orgId: org.id, inviteId: params.inviteId });

  // Shared policy: only an unresolved, unexpired invite still awaiting approval. A revoked,
  // declined or accepted invite is no longer approvable — approving would email a link acceptance
  // refuses — and neither is an expired one. Generic 400 for every case, so this is no oracle.
  assertTeamInviteTransition({ transition: 'approve', invite, now });

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
    actorUserId: reviewerUserId,
    actor: params.actor,
    action: 'invite.approved',
    targetType: 'invite',
    targetId: updated.id,
    metadata: { teamId: invite.team.id },
  });

  return toInviteRecord(updated, now, org.domain);
}

/** `POST /org/organisations/:orgId/invitations/:inviteId/deny` — owner/admin only; silent to the invitee. */
export async function denyInvite(
  params: {
    orgId: string;
    domain: string;
    inviteId: string;
    /** Absent in backend mode: nobody reviewed it, the backend decided. */
    reviewerUserId?: string;
    actor?: OrgActorProvenance;
  },
  deps?: InviteDeps,
): Promise<TeamInviteRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const reviewerUserId = resolveOrgActor({ actorUserId: params.reviewerUserId, actor: params.actor });
  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();

  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });
  const invite = await findOrgInviteOrThrow({ prisma, orgId: org.id, inviteId: params.inviteId });

  // Shared policy: only an unresolved invite still awaiting approval. A revoked, declined or
  // accepted invite already carries its terminal state and denying it after the fact would
  // overwrite the honest record. Unlike approval there is no expiry gate — expiry blocks approving
  // and accepting, never the terminal cleanup decision.
  assertTeamInviteTransition({ transition: 'deny', invite, now });

  const updated = await prisma.teamInvite.update({
    where: { id: invite.id },
    data: { approvalStatus: 'DENIED' },
    select: TEAM_INVITE_SELECT,
  });

  await auditOrg({
    orgId: org.id,
    actorUserId: reviewerUserId,
    actor: params.actor,
    action: 'invite.denied',
    targetType: 'invite',
    targetId: updated.id,
    metadata: { teamId: invite.team.id },
  });

  return toInviteRecord(updated, now, org.domain);
}
