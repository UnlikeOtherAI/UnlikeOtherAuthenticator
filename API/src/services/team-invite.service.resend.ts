import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { assertDatabaseEnabled } from './organisation.service.base.js';
import { buildUserIdentity } from './user-scope.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { sendTeamInviteEmail } from './email.service.js';
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
  resolveBaseUrl,
  resolveInviteTarget,
  toInviteRecord,
  type InvitePrisma,
} from './team-invite.service.base.js';

// Split out of team-invite.service.management.ts (which was at the 500-line cap) so Phase 4's
// expiry-refresh addition (Task 3) has room without pushing either file over the limit.
export async function resendTeamInvite(params: {
  orgId: string;
  teamId: string;
  inviteId: string;
  domain: string;
  config: ClientConfig;
  configUrl: string;
}, deps?: InviteDeps & {
  sendTeamInviteEmail?: typeof sendTeamInviteEmail;
}): Promise<TeamInviteRecord> {
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

  const invite = await prisma.teamInvite.findFirst({
    where: {
      id: params.inviteId,
      orgId: org.id,
      teamId: team.id,
    },
    select: TEAM_INVITE_SELECT,
  });
  if (!invite) {
    throw new AppError('NOT_FOUND', 404);
  }
  if (invite.acceptedAt) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const identity = buildUserIdentity({
    userScope: params.config.user_scope,
    email: invite.email,
    domain: params.config.domain,
  });
  const existingUser = await prisma.user.findUnique({
    where: { userKey: identity.userKey },
    select: { id: true },
  });
  if (existingUser && params.config.existing_user_registration_behavior === 'inline_sign_in') {
    throw new AppError('BAD_REQUEST', 409, 'EMAIL_ALREADY_REGISTERED');
  }

  await prisma.teamInvite.updateMany({
    where: {
      teamId: team.id,
      email: invite.email,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
    },
  });

  const resentInvite = await prisma.teamInvite.create({
    data: {
      orgId: invite.orgId,
      teamId: invite.teamId,
      email: invite.email,
      inviteName: invite.inviteName,
      teamRole: invite.teamRole,
      redirectUrl: invite.redirectUrl,
      invitedByUserId: invite.invitedByUserId,
      invitedByName: invite.invitedByName,
      invitedByEmail: invite.invitedByEmail,
      lastSentAt: now,
      // Task 3 (design §4.7): resending refreshes the invite-level expiry to now + 30 days,
      // regardless of the prior invite's remaining window (matching Slack's re-invite UX).
      expiresAt: computeInviteExpiresAt(now),
    },
    select: TEAM_INVITE_SELECT,
  });

  const token = await issueInviteToken({
    prisma,
    inviteId: resentInvite.id,
    existingUserId: existingUser?.id ?? null,
    email: resentInvite.email,
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
    theme: extractEmailTheme(params.config),
  });

  return toInviteRecord(resentInvite, now);
}
