import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { requireFundedInvitation } from './billing-invitation-seat.service.js';
import { AppError } from '../utils/errors.js';
import { assertDatabaseEnabled } from './organisation.service.base.js';
import { buildUserIdentity } from './user-scope.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { sendTeamInviteEmail } from './email.service.js';
import { resolveInviterName } from './invite-inviter-label.service.js';
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
  resolveBaseUrl,
  resolveInviteTarget,
  toInviteRecord,
  type InvitePrisma,
} from './team-invite.service.base.js';
import { assertTeamInviteTransition } from './team-invite-state-machine.js';

// Split out of team-invite.service.management.ts (which was at the 500-line cap) so Phase 4's
// expiry-refresh addition (Task 3) has room without pushing either file over the limit.
export async function resendTeamInvite(
  params: {
    orgId: string;
    teamId: string;
    inviteId: string;
    domain: string;
    config: ClientConfig;
    configUrl: string;
  },
  deps?: InviteDeps & {
    sendTeamInviteEmail?: typeof sendTeamInviteEmail;
  },
): Promise<TeamInviteRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendInviteEmail = deps?.sendTeamInviteEmail ?? sendTeamInviteEmail;

  const { org, team } = await resolveInviteTarget({
    prisma,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  // The route holds this lock through prepare/commit. Two requests from the same
  // open dialog must see the same immediate successor.
  if (deps?.afterCommit) await prisma.$queryRaw`SELECT id FROM team_invites
    WHERE id=${params.inviteId} AND org_id=${org.id} AND team_id=${team.id} FOR UPDATE`;
  const original = await prisma.teamInvite.findFirst({
    where: {
      id: params.inviteId,
      orgId: org.id,
      teamId: team.id,
    },
    select: TEAM_INVITE_SELECT,
  });
  if (!original) {
    throw new AppError('NOT_FOUND', 404);
  }
  const successor = original.revokedReason === 'REPLACED' && original.revokedAt
    ? await prisma.teamInvite.findFirst({ where: { resendOfId: original.id, orgId: org.id,
      teamId: team.id, email: original.email, ...ACTIONABLE_TEAM_INVITE_WHERE,
      expiresAt: { gt: now } }, select: TEAM_INVITE_SELECT })
    : null;
  const invite = successor ?? original;
  // Shared policy: an accepted, declined, revoked or DENIED invite cannot be resent, and neither
  // can one still awaiting approval (nothing has been approved to mail yet). Resending used to
  // check only `acceptedAt`, so it could resurrect an invite an admin had just revoked, or mail an
  // invite whose approval was still pending.
  assertTeamInviteTransition({ transition: 'resend', invite, now });
  // The stored role is revalidated against the domain's *current* vocabulary and the owner rail
  // before it is copied onto the replacement row, so a role that is no longer invitable fails with
  // the generic 400 rather than a raw constraint violation.
  const teamRole = normalizeInviteGrantRole(invite.teamRole, params.config);

  const identity = buildUserIdentity({
    userScope: params.config.user_scope,
    email: invite.email,
    domain: params.config.domain,
  });
  const existingUser = await prisma.user.findUnique({
    where: { lifecycleStatus: 'ACTIVE', userKey: identity.userKey },
    select: { id: true, tokenVersion: true },
  });
  if (existingUser && params.config.existing_user_registration_behavior === 'inline_sign_in') {
    throw new AppError('BAD_REQUEST', 409, 'EMAIL_ALREADY_REGISTERED');
  }

  const replace = async () => {
    // Frees the actionable slot before the replacement row is created, so the new invite cannot
    // collide with `team_invites_one_actionable_per_team_email`.
    const revoked = await prisma.teamInvite.updateMany({
      where: {
        ...ACTIONABLE_TEAM_INVITE_WHERE,
        id: invite.id,
      },
      data: {
        revokedAt: now,
        revokedReason: 'REPLACED',
      },
    });

    if (revoked.count !== 1) throw new AppError('BAD_REQUEST', 409);
    return prisma.teamInvite.create({
      data: {
        resendOfId: invite.id,
        orgId: invite.orgId,
        teamId: invite.teamId,
        email: invite.email,
        inviteName: invite.inviteName,
        teamRole,
        redirectUrl: invite.redirectUrl,
        invitedByUserId: invite.invitedByUserId,
        invitedByName: invite.invitedByName,
        invitedByEmail: invite.invitedByEmail,
        lastSentAt: now,
        // Resending replaces the prior invite with a fresh 24-hour capability, regardless of the
        // prior invite's remaining window.
        expiresAt: computeInviteExpiresAt(now),
      },
      select: TEAM_INVITE_SELECT,
    });
  };
  const resentInvite = successor ?? await replace();

  const deliver = async (prisma: InvitePrisma) => {
    if (deps?.afterCommit) {
      await prisma.$queryRaw`SELECT id FROM team_invites WHERE id=${resentInvite.id} FOR UPDATE`;
      // A concurrent retry can arrive after the first mail transaction commits.
      if (await prisma.verificationToken.findFirst({ where: { teamInviteId: resentInvite.id,
        usedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } })) {
        await requireFundedInvitation(prisma, resentInvite.id);
        return;
      }
    }
    const token = await issueInviteToken({
      prisma,
      inviteId: resentInvite.id,
      existingUser,
      email: resentInvite.email,
      userKey: identity.userKey,
      domain: identity.domain,
      config: params.config,
      configUrl: params.configUrl,
      now: resentInvite.lastSentAt,
      sharedSecret: deps?.sharedSecret,
      generateEmailTokenFn: deps?.generateEmailToken,
      hashEmailTokenFn: deps?.hashEmailToken ?? hashEmailToken,
    });

    const link = buildTeamInviteLink({
      baseUrl: resolveBaseUrl(env),
      token,
      configUrl: params.configUrl,
      redirectUrl: resentInvite.redirectUrl ?? undefined,
    });

    await sendInviteEmail({
      to: resentInvite.email,
      link,
      trackingPixelUrl: buildTeamInviteTrackingPixelUrl({
        baseUrl: resolveBaseUrl(env),
        inviteId: resentInvite.id,
      }),
      organisationName: org.name,
      teamName: team.name,
      inviteeName: resentInvite.inviteName ?? undefined,
      inviterName: (await resolveInviterName(resentInvite, { prisma: deps?.inviterPrisma })) ?? undefined,
      theme: extractEmailTheme(params.config),
    });
  };
  if (deps?.afterCommit) deps.afterCommit(resentInvite.id, deliver);
  else await deliver(prisma);

  return toInviteRecord(resentInvite, now, org.domain);
}
