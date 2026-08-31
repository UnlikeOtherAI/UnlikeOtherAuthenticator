import type { PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { buildUserIdentity } from './user-scope.service.js';
import { acceptTeamInviteWithinTransaction } from './team-invite.service.acceptance.js';
import {
  lockAndReadVerificationTokenEpoch,
  readVerificationTokenEpoch,
} from './verification-token-epoch.service.js';

type InviteTokenPrisma = PrismaClient;

type InviteTokenType = 'LOGIN_LINK' | 'VERIFY_EMAIL' | 'VERIFY_EMAIL_SET_PASSWORD';

type InviteTokenRow = {
  id: string;
  type: string;
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
    approvalStatus: string;
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
  // Revoked sits beside the used/expired checks above, but carries a distinct internal code so the
  // hosted landing page can say WHY the link is dead. This is not an oracle: only the holder of the
  // emailed token can reach it, and that person already knows the invite existed. Every other
  // failure stays the same generic error.
  if (params.row.teamInvite.revokedAt) {
    throw new AppError('BAD_REQUEST', 400, 'INVITE_REVOKED');
  }
  if (params.row.teamInvite.acceptedAt || params.row.teamInvite.declinedAt) {
    throw new AppError('BAD_REQUEST', 400);
  }
  // A DENIED invite is resolved even though it carries no terminal timestamp. In practice an
  // invite awaiting approval is never emailed a token, so this is defence in depth rather than a
  // reachable gate — but it keeps the token path agreeing with `isResolved` in the state machine.
  if (params.row.teamInvite.approvalStatus === 'DENIED') {
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
  return await params.prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      type: true,
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
          approvalStatus: true,
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
 * Consumes an invitation capability after a social provider has verified the
 * invitee's address. The caller holds the surrounding admin transaction: user
 * creation, exact-email validation, invite acceptance, and token consumption
 * therefore commit together.
 *
 * A pre-user token normally requires its userKey to remain absent. Social
 * registration necessarily creates that row first, so this path instead binds
 * the fresh identity directly to the token's exact userKey and invited email.
 */
export async function acceptTeamInviteTokenForSocialLogin(
  params: {
    token: string;
    configUrl: string;
    config: ClientConfig;
    userId: string;
    credentialEpoch: number;
    email: string;
  },
  deps?: InviteTokenDeps,
): Promise<{ orgId: string; teamId: string }> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? getPrisma();
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const row = await findInviteToken({ prisma, token: params.token, sharedSecret });
  if (!row) {
    throw new AppError('BAD_REQUEST', 400);
  }

  assertInviteTokenValid({ row, configUrl: params.configUrl, now });
  const teamInvite = requireTeamInvite(row);
  const normalizedEmail = params.email.trim().toLowerCase();
  if (teamInvite.email.toLowerCase() !== normalizedEmail) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const identity = buildUserIdentity({
    userScope: params.config.user_scope,
    email: normalizedEmail,
    domain: params.config.domain,
  });
  if (row.userKey !== identity.userKey) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (
    (row.userId !== null && row.userId !== params.userId) ||
    (row.tokenVersion !== null && row.tokenVersion !== params.credentialEpoch)
  ) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const workspace = await acceptTeamInviteWithinTransaction({
    prisma,
    teamInviteId: teamInvite.id,
    userId: params.userId,
    config: params.config,
    now,
  });
  const consumed = await prisma.verificationToken.updateMany({
    where: {
      id: row.id,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      usedAt: now,
      userId: params.userId,
    },
  });
  if (consumed.count !== 1) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return workspace;
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
