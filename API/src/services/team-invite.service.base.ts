import type { PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { generateEmailToken, hashEmailToken } from '../utils/verification-token.js';
import {
  normalizeDomain,
  resolveOrganisationByDomain,
} from './organisation.service.base.js';

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
  openedAt: Date | null;
  openCount: number;
  lastSentAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamInviteStatus = 'pending' | 'accepted' | 'declined' | 'replaced';

export type TeamInviteRecord = PendingInviteRow & {
  status: TeamInviteStatus;
};

export type TeamInviteCreateResult =
  | { email: string; status: 'invited'; invite: TeamInviteRecord }
  | { email: string; status: 'resent_existing'; invite: TeamInviteRecord }
  | { email: string; status: 'already_member' }
  | { email: string; status: 'conflict' };

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

export function toInviteRecord(row: PendingInviteRow): TeamInviteRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    teamId: row.teamId,
    email: row.email,
    inviteName: row.inviteName,
    teamRole: row.teamRole,
    redirectUrl: row.redirectUrl,
    invitedByUserId: row.invitedByUserId,
    invitedByName: row.invitedByName,
    invitedByEmail: row.invitedByEmail,
    acceptedUserId: row.acceptedUserId,
    acceptedAt: row.acceptedAt,
    declinedAt: row.declinedAt,
    revokedAt: row.revokedAt,
    openedAt: row.openedAt,
    openCount: row.openCount,
    lastSentAt: row.lastSentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.acceptedAt
      ? 'accepted'
      : row.declinedAt
        ? 'declined'
        : row.revokedAt
          ? 'replaced'
          : 'pending',
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

function inviteTokenType(existingUserId: string | null, config: ClientConfig): 'LOGIN_LINK' | 'VERIFY_EMAIL' | 'VERIFY_EMAIL_SET_PASSWORD' {
  if (existingUserId) {
    return 'LOGIN_LINK';
  }

  return config.registration_mode === 'passwordless'
    ? 'VERIFY_EMAIL'
    : 'VERIFY_EMAIL_SET_PASSWORD';
}

export async function issueInviteToken(params: {
  prisma: InvitePrisma;
  inviteId: string;
  existingUserId: string | null;
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
      type: inviteTokenType(params.existingUserId, params.config),
      email: params.email,
      userKey: params.userKey,
      domain: params.domain,
      configUrl: params.configUrl,
      tokenHash,
      expiresAt,
      userId: params.existingUserId,
      teamInviteId: params.inviteId,
    },
  });

  return token;
}

export async function resolveInviteTarget(params: {
  prisma: InvitePrisma;
  orgId: string;
  teamId: string;
  domain: string;
}): Promise<{
  org: { id: string; domain: string; name: string };
  team: { id: string; name: string };
}> {
  const org = await resolveOrganisationByDomain(params.prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

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
    },
    team,
  };
}

export { getEnv, generateEmailToken, hashEmailToken, normalizeDomain };
