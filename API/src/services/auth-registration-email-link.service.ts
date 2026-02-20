import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';

type RegistrationEmailLinkPrisma = {
  verificationToken: Pick<PrismaClient['verificationToken'], 'findUnique'>;
};

function assertRegistrationLandingTokenValid(params: {
  token: Prisma.VerificationTokenGetPayload<{
    select: {
      type: true;
      configUrl: true;
      expiresAt: true;
      usedAt: true;
    };
  }>;
  configUrl: string;
  now: Date;
}): void {
  if (params.token.configUrl !== params.configUrl) {
    // Token is bound to the original config URL to avoid cross-client replay.
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_CONFIG_URL');
  }

  if (params.token.usedAt) {
    throw new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED');
  }

  if (params.token.expiresAt.getTime() <= params.now.getTime()) {
    throw new AppError('BAD_REQUEST', 400, 'TOKEN_EXPIRED');
  }
}

export async function validateRegistrationEmailLandingToken(params: {
  token: string;
  configUrl: string;
  config: ClientConfig;
}): Promise<'LOGIN_LINK' | 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL'> {
  void params.config; // Included for future-proofing; configVerifier already validates domain integrity.
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const tokenHash = hashEmailToken(params.token, SHARED_SECRET);

  const prisma = getPrisma() as unknown as RegistrationEmailLinkPrisma;
  const row = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: {
      type: true,
      configUrl: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  if (!row) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
  }

  assertRegistrationLandingTokenValid({ token: row, configUrl: params.configUrl, now: new Date() });
  const type = row.type;
  if (type !== 'LOGIN_LINK' && type !== 'VERIFY_EMAIL_SET_PASSWORD' && type !== 'VERIFY_EMAIL') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_TYPE');
  }
  return type;
}
