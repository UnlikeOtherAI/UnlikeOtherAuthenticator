import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { readVerificationTokenEpoch } from './verification-token-epoch.service.js';

type RegistrationEmailLinkPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
  verificationToken: Pick<PrismaClient['verificationToken'], 'findUnique'>;
};

type RegistrationLandingToken = Prisma.VerificationTokenGetPayload<{
  select: {
    type: true;
    configUrl: true;
    expiresAt: true;
    teamInviteId: true;
    tokenVersion: true;
    usedAt: true;
    userId: true;
    userKey: true;
    teamInvite: {
      select: {
        acceptedAt: true;
        declinedAt: true;
        revokedAt: true;
        expiresAt: true;
        approvalStatus: true;
      };
    };
  };
}>;

type RegistrationLandingTokenType = 'LOGIN_LINK' | 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL';

function isRegistrationLandingTokenType(type: string): type is RegistrationLandingTokenType {
  return type === 'LOGIN_LINK' || type === 'VERIFY_EMAIL_SET_PASSWORD' || type === 'VERIFY_EMAIL';
}

function invalidInvitationOrToken(params: RegistrationLandingToken, message: string): never {
  throw new AppError('BAD_REQUEST', 400, params.teamInviteId ? 'INVITE_INVALID' : message);
}

function assertRegistrationLandingTokenStructure(params: {
  token: RegistrationLandingToken;
  configUrl: string;
}): void {
  if (params.token.configUrl !== params.configUrl) {
    // Token is bound to the original config URL to avoid cross-client replay.
    invalidInvitationOrToken(params.token, 'INVALID_TOKEN_CONFIG_URL');
  }

  if (params.token.usedAt) {
    invalidInvitationOrToken(params.token, 'TOKEN_ALREADY_USED');
  }

  if (!params.token.teamInviteId) return;

  const invite = params.token.teamInvite;
  if (
    !isRegistrationLandingTokenType(params.token.type) ||
    !invite ||
    invite.revokedAt ||
    invite.acceptedAt ||
    invite.declinedAt ||
    (invite.approvalStatus !== 'NOT_REQUIRED' && invite.approvalStatus !== 'APPROVED')
  ) {
    invalidInvitationOrToken(params.token, 'INVALID_TOKEN');
  }
}

function assertRegistrationLandingTokenNotExpired(params: {
  token: RegistrationLandingToken;
  now: Date;
}): void {
  if (params.token.expiresAt.getTime() <= params.now.getTime()) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      params.token.teamInviteId ? 'INVITE_EXPIRED' : 'TOKEN_EXPIRED',
    );
  }

  if (
    params.token.teamInviteId &&
    params.token.teamInvite?.expiresAt &&
    params.token.teamInvite.expiresAt.getTime() <= params.now.getTime()
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVITE_EXPIRED');
  }
}

export async function validateRegistrationEmailLandingToken(
  params: {
    token: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: { prisma?: RegistrationEmailLinkPrisma },
): Promise<RegistrationLandingTokenType> {
  void params.config; // Included for future-proofing; configVerifier already validates domain integrity.
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const tokenHash = hashEmailToken(params.token, SHARED_SECRET);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as RegistrationEmailLinkPrisma);
  const row = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: {
      type: true,
      configUrl: true,
      expiresAt: true,
      teamInviteId: true,
      tokenVersion: true,
      usedAt: true,
      userId: true,
      userKey: true,
      teamInvite: {
        select: {
          acceptedAt: true,
          declinedAt: true,
          revokedAt: true,
          expiresAt: true,
          approvalStatus: true,
        },
      },
    },
  });

  if (!row) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
  }

  const now = new Date();
  assertRegistrationLandingTokenStructure({ token: row, configUrl: params.configUrl });
  const epoch = await readVerificationTokenEpoch(prisma, row);
  if (!epoch) {
    throw new AppError('BAD_REQUEST', 400, row.teamInviteId ? 'INVITE_INVALID' : 'INVALID_TOKEN');
  }
  assertRegistrationLandingTokenNotExpired({ token: row, now });
  if (!isRegistrationLandingTokenType(row.type)) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      row.teamInviteId ? 'INVITE_INVALID' : 'INVALID_TOKEN_TYPE',
    );
  }
  return row.type;
}
