import type { PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { generateEmailToken, hashEmailToken } from '../utils/verification-token.js';
import {
  memberAvatarImageUrl,
  normalizeDomain,
  resolveOrganisation,
} from './organisation.service.base.js';
import { OWNER_ROLE } from './role-grants.js';
import {
  deriveInviteStatus,
  type TeamInviteStatusValue,
} from './team-invite-state-machine.js';
import { normalizeTeamRole } from './team.service.base.js';

export type InvitePrisma = PrismaClient;

export type InviteDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: InvitePrisma;
  now?: () => Date;
  sharedSecret?: string;
  generateEmailToken?: typeof generateEmailToken;
  hashEmailToken?: typeof hashEmailToken;
};

type PendingInviteRow = {
  id: string;
  orgId: string;
  teamId: string;
  email: string;
  inviteName: string | null;
  teamRole: string;
  redirectUrl: string | null;
  invitedByUserId: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  acceptedUserId: string | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  openedAt: Date | null;
  openCount: number;
  lastSentAt: Date;
  expiresAt: Date | null;
  approvalStatus: string;
  requestedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// Shared Prisma `select` for every team-invite read/write across the split service files
// (management/resend/member/acceptance). Keeping one source of truth means a new column only has
// to be added here instead of at every call site's repeated select block.
export const TEAM_INVITE_SELECT = {
  id: true,
  orgId: true,
  teamId: true,
  email: true,
  inviteName: true,
  teamRole: true,
  redirectUrl: true,
  invitedByUserId: true,
  invitedByName: true,
  invitedByEmail: true,
  acceptedUserId: true,
  acceptedAt: true,
  declinedAt: true,
  revokedAt: true,
  revokedReason: true,
  openedAt: true,
  openCount: true,
  lastSentAt: true,
  expiresAt: true,
  approvalStatus: true,
  requestedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// 30-day default invite window (design §4.7): new/resent invites set `expiresAt = now + 30 days`;
// the foundation migration backfills the same window onto pre-existing unresolved invites so the
// Task 3 expiry gate is behaviour-preserving.
const INVITE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export function computeInviteExpiresAt(now: Date): Date {
  return new Date(now.getTime() + INVITE_EXPIRY_MS);
}

/** Re-exported under its established name; the values live with the derivation that produces them. */
export type TeamInviteStatus = TeamInviteStatusValue;
export type InviteApprovalStatusValue = 'not_required' | 'pending' | 'approved' | 'denied';

export type TeamInviteRecord = Omit<PendingInviteRow, 'approvalStatus'> & {
  status: TeamInviteStatus;
  approvalStatus: InviteApprovalStatusValue;
  // Docs/Auth/avatars.md §9. Null until the corresponding user id exists — the invitee's own
  // `email` deliberately gets no avatar URL: an unaccepted invite has no UOA user behind it.
  invitedByAvatarImageUrl: string | null;
  acceptedAvatarImageUrl: string | null;
};

export type TeamInviteCreateResult =
  | { email: string; status: 'invited'; invite: TeamInviteRecord }
  | { email: string; status: 'resent_existing'; invite: TeamInviteRecord }
  | { email: string; status: 'already_member' }
  | { email: string; status: 'existing_user' }
  | { email: string; status: 'conflict' };

/**
 * Prisma `where` fragment for the actionable-invite predicate — exactly the predicate of the
 * `team_invites_one_actionable_per_team_email` partial unique index: not accepted, not declined,
 * not revoked, and approval not DENIED. Every read/write that must only ever see the one live
 * invite for a `(team, email)` filters through this, so a terminal row can never be resent,
 * re-tracked, or counted as the existing invite.
 *
 * Kept beside the index it mirrors, and matched by `isActionable` in the state machine.
 */
export const ACTIONABLE_TEAM_INVITE_WHERE = {
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  approvalStatus: { not: 'DENIED' },
} as const;

/**
 * The role an invitation may grant: any role in the domain's own `team_roles` vocabulary EXCEPT
 * `owner`.
 *
 * Two separate rules, deliberately composed rather than merged into one hard-coded list:
 *
 *  - the vocabulary is the domain's (`normalizeTeamRole` against configured `team_roles`), so a
 *    domain that renamed or invented its roles can invite into them;
 *  - `owner` is refused structurally. `owner` is the one fixed role in every vocabulary and
 *    implicitly holds every capability at its scope (`role-grants.ts`), so an emailed invitation
 *    granting it would hand full authority over a team to whoever controls a mailbox. Ownership
 *    comes from direct membership management, never from an invite.
 *
 * The database mirrors only the second rule (`team_invites_team_role_check`: `team_role <>
 * 'owner'`), because the first is per-domain configuration the database cannot see.
 */
export function normalizeInviteGrantRole(value: string | undefined, config: ClientConfig): string {
  const role = normalizeTeamRole(value, config);
  if (role === OWNER_ROLE) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return role;
}

export function normalizeInviteName(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return trimmed;
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return email;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function toApprovalStatusValue(value: string | null | undefined): InviteApprovalStatusValue {
  if (!value) return 'not_required';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'not_required' ||
    normalized === 'pending' ||
    normalized === 'approved' ||
    normalized === 'denied'
  ) {
    return normalized;
  }
  return 'not_required';
}

/**
 * Derives the invite's read-only status (Task 3, design §4.7). Every call site threads its own `now`
 * through so status derivation is consistent with whatever timestamp the surrounding operation
 * already used, and its resolved org `domain` so the avatar URLs (Docs/Auth/avatars.md §9) are
 * fetchable with the same credential the caller used.
 */
export function toInviteRecord(
  row: PendingInviteRow,
  now: Date,
  domain: string,
): TeamInviteRecord {
  const { approvalStatus, ...rest } = row;

  return {
    ...rest,
    approvalStatus: toApprovalStatusValue(approvalStatus),
    invitedByAvatarImageUrl: row.invitedByUserId
      ? memberAvatarImageUrl(domain, row.invitedByUserId)
      : null,
    acceptedAvatarImageUrl: row.acceptedUserId
      ? memberAvatarImageUrl(domain, row.acceptedUserId)
      : null,
    // One implementation, shared with the state machine, so the status a product reads and the
    // status the transition rules reason about can never disagree.
    status: deriveInviteStatus(row, now),
  };
}

export function buildTeamInviteLink(params: {
  baseUrl: string;
  token: string;
  configUrl: string;
  redirectUrl?: string;
}): string {
  const url = new URL(`${normalizeBaseUrl(params.baseUrl)}/auth/email/team-invite`);
  url.searchParams.set('token', params.token);
  url.searchParams.set('config_url', params.configUrl);
  if (params.redirectUrl) {
    url.searchParams.set('redirect_url', params.redirectUrl);
  }
  return url.toString();
}

export function buildTeamInviteTrackingPixelUrl(params: {
  baseUrl: string;
  inviteId: string;
}): string {
  return `${normalizeBaseUrl(params.baseUrl)}/auth/email/team-invite-open/${params.inviteId}.gif`;
}

export function resolveBaseUrl(env: ReturnType<typeof getEnv>): string {
  return env.PUBLIC_BASE_URL
    ? normalizeBaseUrl(env.PUBLIC_BASE_URL)
    : `http://${env.HOST}:${env.PORT}`;
}

function inviteTokenType(
  existingUser: { id: string; tokenVersion: number } | null,
  config: ClientConfig,
): 'LOGIN_LINK' | 'VERIFY_EMAIL' | 'VERIFY_EMAIL_SET_PASSWORD' {
  if (existingUser) {
    return 'LOGIN_LINK';
  }

  return config.registration_mode === 'passwordless' ? 'VERIFY_EMAIL' : 'VERIFY_EMAIL_SET_PASSWORD';
}

export async function issueInviteToken(params: {
  prisma: InvitePrisma;
  inviteId: string;
  existingUser: { id: string; tokenVersion: number } | null;
  email: string;
  userKey: string;
  domain: string | null;
  config: ClientConfig;
  configUrl: string;
  now: Date;
  sharedSecret?: string;
  generateEmailTokenFn?: typeof generateEmailToken;
  hashEmailTokenFn?: typeof hashEmailToken;
}): Promise<string> {
  const sharedSecret = params.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const generateEmailTokenFn = params.generateEmailTokenFn ?? generateEmailToken;
  const hashEmailTokenFn = params.hashEmailTokenFn ?? hashEmailToken;
  const token = generateEmailTokenFn();
  const tokenHash = hashEmailTokenFn(token, sharedSecret);
  const expiresAt = new Date(params.now.getTime() + EMAIL_TOKEN_TTL_MS);

  await params.prisma.verificationToken.updateMany({
    where: {
      teamInviteId: params.inviteId,
      usedAt: null,
    },
    data: {
      usedAt: params.now,
    },
  });

  await params.prisma.verificationToken.create({
    data: {
      type: inviteTokenType(params.existingUser, params.config),
      email: params.email,
      userKey: params.userKey,
      domain: params.domain,
      configUrl: params.configUrl,
      tokenHash,
      expiresAt,
      userId: params.existingUser?.id ?? null,
      tokenVersion: params.existingUser?.tokenVersion ?? null,
      teamInviteId: params.inviteId,
    },
  });

  return token;
}

export async function resolveInviteTarget(params: {
  prisma: InvitePrisma;
  orgId: string;
  teamId: string;
}): Promise<{
  org: { id: string; domain: string; name: string; memberInvites?: string };
  team: { id: string; name: string };
}> {
  const org = await resolveOrganisation(params.prisma, { orgId: params.orgId });

  const team = await params.prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: {
      id: true,
      name: true,
    },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  return {
    org: {
      id: org.id,
      domain: org.domain,
      name: org.name,
      memberInvites: org.memberInvites,
    },
    team,
  };
}

export { getEnv, generateEmailToken, hashEmailToken, normalizeDomain };
