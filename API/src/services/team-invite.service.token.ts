import type { PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';

type InviteTokenPrisma = PrismaClient;

type InviteTokenType = 'LOGIN_LINK' | 'VERIFY_EMAIL' | 'VERIFY_EMAIL_SET_PASSWORD';

type InviteTokenRow = {
  id: string;
  type: string;
  configUrl: string;
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
  return await params.prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      type: true,
      configUrl: true,
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

export async function getTeamInviteLandingData(params: {
  token: string;
  configUrl: string;
  config: ClientConfig;
}, deps?: InviteTokenDeps): Promise<{
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

export async function declineTeamInviteByToken(params: {
  token: string;
  configUrl: string;
  config: ClientConfig;
}, deps?: InviteTokenDeps): Promise<{
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

  return await prisma.$transaction(async (tx) => {
    const row = await findInviteToken({
      prisma: tx as unknown as InviteTokenPrisma,
      token: params.token,
      sharedSecret,
    });
    if (!row) {
      throw new AppError('BAD_REQUEST', 400);
    }

    assertInviteTokenValid({
      row,
      configUrl: params.configUrl,
      now,
    });
    const teamInvite = requireTeamInvite(row);

    await tx.teamInvite.update({
      where: { id: teamInvite.id },
      data: { declinedAt: now },
      select: { id: true },
    });
    await tx.verificationToken.updateMany({
      where: {
        teamInviteId: teamInvite.id,
        usedAt: null,
      },
      data: {
        usedAt: now,
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
