import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import {
  lockAndReadVerificationTokenEpoch,
  readVerificationTokenEpoch,
} from './verification-token-epoch.service.js';
import { acceptTeamInviteWithinTransaction } from './team-invite.service.acceptance.js';

type InviteTokenPrisma = PrismaClient;

type InviteTokenType = 'LOGIN_LINK' | 'VERIFY_EMAIL' | 'VERIFY_EMAIL_SET_PASSWORD';

type InviteTokenRow = {
  id: string;
  type: string;
  email: string;
  configUrl: string;
  tokenVersion: number | null;
  userId: string | null;
  userKey: string;
  teamInviteId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  teamInvite: null | {
    id: string;
    inviteName: string | null;
    email: string;
    acceptedAt: Date | null;
    declinedAt: Date | null;
    revokedAt: Date | null;
    team: { name: string };
    org: { name: string };
  };
};

type InviteTokenDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: InviteTokenPrisma;
  sharedSecret?: string;
  now?: () => Date;
};

function assertInviteTokenType(type: string): asserts type is InviteTokenType {
  if (type !== 'LOGIN_LINK' && type !== 'VERIFY_EMAIL' && type !== 'VERIFY_EMAIL_SET_PASSWORD') {
    throw new AppError('BAD_REQUEST', 400);
  }
}

function assertInviteTokenValid(params: {
  row: InviteTokenRow;
  configUrl: string;
  now: Date;
}): InviteTokenType {
  if (params.row.configUrl !== params.configUrl) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (params.row.usedAt || params.row.expiresAt.getTime() <= params.now.getTime()) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (!params.row.teamInviteId || !params.row.teamInvite) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (
    params.row.teamInvite.acceptedAt ||
    params.row.teamInvite.declinedAt ||
    params.row.teamInvite.revokedAt
  ) {
    throw new AppError('BAD_REQUEST', 400);
  }

  assertInviteTokenType(params.row.type);
  return params.row.type;
}

async function findInviteToken(params: {
  prisma: InviteTokenPrisma;
  token: string;
  sharedSecret: string;
}): Promise<InviteTokenRow | null> {
  const tokenHash = hashEmailToken(params.token, params.sharedSecret);
  return await findInviteTokenByHash({ prisma: params.prisma, tokenHash });
}

async function findInviteTokenByHash(params: {
  prisma: InviteTokenPrisma;
  tokenHash: string;
}): Promise<InviteTokenRow | null> {
  return await params.prisma.verificationToken.findUnique({
    where: { tokenHash: params.tokenHash },
    select: {
      id: true,
      type: true,
      email: true,
      configUrl: true,
      tokenVersion: true,
      userId: true,
      userKey: true,
      teamInviteId: true,
      expiresAt: true,
      usedAt: true,
      teamInvite: {
        select: {
          id: true,
          inviteName: true,
          email: true,
          acceptedAt: true,
          declinedAt: true,
          revokedAt: true,
          team: { select: { name: true } },
          org: { select: { name: true } },
        },
      },
    },
  });
}

function requireTeamInvite(row: InviteTokenRow): NonNullable<InviteTokenRow['teamInvite']> {
  if (!row.teamInvite) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return row.teamInvite;
}

export async function getTeamInviteLandingData(
  params: {
    token: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: InviteTokenDeps,
): Promise<{
  tokenType: InviteTokenType;
  inviteId: string;
  email: string;
  inviteName: string | null;
  teamName: string;
  organisationName: string;
}> {
  void params.config;
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? getPrisma();
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const row = await findInviteToken({
    prisma,
    token: params.token,
    sharedSecret,
  });
  if (!row) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const tokenType = assertInviteTokenValid({
    row,
    configUrl: params.configUrl,
    now,
  });
  const epoch = await readVerificationTokenEpoch(prisma, row);
  if (!epoch) {
    throw new AppError('BAD_REQUEST', 400);
  }
  const teamInvite = requireTeamInvite(row);

  return {
    tokenType,
    inviteId: teamInvite.id,
    email: teamInvite.email,
    inviteName: teamInvite.inviteName,
    teamName: teamInvite.team.name,
    organisationName: teamInvite.org.name,
  };
}

/**
 * Resolve the short-lived continuation placed in signed social OAuth state.
 * The state deliberately carries the peppered token hash rather than the raw
 * email capability, so the provider never receives the token itself.
 */
export async function getTeamInviteSocialContinuationData(params: {
  tokenHash: string;
  configUrl: string;
  config: ClientConfig;
  prisma: InviteTokenPrisma;
  now?: Date;
}): Promise<{ email: string }> {
  void params.config;
  const row = await findInviteTokenByHash({
    prisma: params.prisma,
    tokenHash: params.tokenHash,
  });
  if (!row) {
    throw new AppError('BAD_REQUEST', 400);
  }

  assertInviteTokenValid({
    row,
    configUrl: params.configUrl,
    now: params.now ?? new Date(),
  });
  if (!(await readVerificationTokenEpoch(params.prisma, row))) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return { email: row.email };
}

/**
 * Consume an email-team-invite continuation after a social provider has
 * verified the invitee's email. This issues no OAuth authorization code: an
 * email invite joins a workspace, while a product sign-in must begin its own
 * PKCE-bound authorization-code flow.
 */
export async function acceptTeamInviteSocialContinuation(params: {
  tokenHash: string;
  configUrl: string;
  config: ClientConfig;
  userId: string;
  prisma: Prisma.TransactionClient;
  now?: Date;
}): Promise<void> {
  const row = await findInviteTokenByHash({
    prisma: params.prisma as unknown as InviteTokenPrisma,
    tokenHash: params.tokenHash,
  });
  if (!row) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const decisionNow = params.now ?? new Date();
  assertInviteTokenValid({ row, configUrl: params.configUrl, now: decisionNow });

  const user = await params.prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, userKey: true },
  });
  if (
    !user ||
    user.email.toLowerCase() !== row.email.toLowerCase() ||
    user.userKey !== row.userKey
  ) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (row.userId === null && row.tokenVersion === null) {
    // A pre-registration invite is consumed only after the provider has proven
    // the exact invited mailbox above. It cannot use the normal epoch helper:
    // that deliberately rejects a token once this social login has created the
    // matching UOA user.
  } else {
    const epoch = await lockAndReadVerificationTokenEpoch(params.prisma, row);
    if (epoch?.kind !== 'user' || epoch.userId !== params.userId) {
      throw new AppError('BAD_REQUEST', 400);
    }
  }

  // Claim before changing membership. The conditional update makes concurrent
  // callbacks harmless; an unsuccessful branch rolls the claim back with the
  // surrounding request transaction.
  const claimed = await params.prisma.verificationToken.updateMany({
    where: {
      id: row.id,
      usedAt: null,
      expiresAt: { gt: decisionNow },
    },
    data: { usedAt: decisionNow, userId: params.userId },
  });
  if (claimed.count !== 1) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await acceptTeamInviteWithinTransaction({
    prisma: params.prisma,
    teamInviteId: requireTeamInvite(row).id,
    userId: params.userId,
    config: params.config,
    now: decisionNow,
  });
}

export async function declineTeamInviteByToken(
  params: {
    token: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: InviteTokenDeps,
): Promise<{
  email: string;
  inviteName: string | null;
  teamName: string;
  organisationName: string;
}> {
  void params.config;
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? getPrisma();
  const readNow = deps?.now ?? (() => new Date());
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;

  return await runInTransaction(prisma, async (tx) => {
    const row = await findInviteToken({
      prisma: tx as unknown as InviteTokenPrisma,
      token: params.token,
      sharedSecret,
    });
    if (!row) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const epoch = await lockAndReadVerificationTokenEpoch(tx, row);
    const decisionNow = readNow();
    if (!epoch) {
      throw new AppError('BAD_REQUEST', 400);
    }
    assertInviteTokenValid({
      row,
      configUrl: params.configUrl,
      now: decisionNow,
    });
    const teamInvite = requireTeamInvite(row);

    await tx.teamInvite.update({
      where: { id: teamInvite.id },
      data: { declinedAt: decisionNow },
      select: { id: true },
    });
    await tx.verificationToken.updateMany({
      where: {
        teamInviteId: teamInvite.id,
        usedAt: null,
      },
      data: {
        usedAt: decisionNow,
      },
    });

    return {
      email: teamInvite.email,
      inviteName: teamInvite.inviteName,
      teamName: teamInvite.team.name,
      organisationName: teamInvite.org.name,
    };
  });
}
