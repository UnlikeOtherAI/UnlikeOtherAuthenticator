import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { decryptTwoFaSecret } from '../utils/twofa-secret.js';
import { findMatchingTotpCounter, verifyTotpCode } from './totp.service.js';

type TwoFaLoginPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique' | 'updateMany'>;
};

type TwoFaLoginDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: TwoFaLoginPrisma;
  sharedSecret?: string;
  decryptTwoFaSecret?: typeof decryptTwoFaSecret;
  findMatchingTotpCounter?: typeof findMatchingTotpCounter;
  verifyTotpCode?: typeof verifyTotpCode;
  now?: () => Date;
};

/**
 * Brief 13 / Phase 8.6: verify a user's TOTP code during login.
 *
 * Caller is responsible for gating this behind config `2fa_enabled` and rate limiting.
 */
export async function verifyTwoFactorForLogin(
  params: { userId: string; code: string },
  deps?: TwoFaLoginDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const sharedSecret = deps?.sharedSecret ?? env.SHARED_SECRET;
  const prisma = deps?.prisma ?? (getPrisma() as unknown as TwoFaLoginPrisma);

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { twoFaEnabled: true, twoFaSecret: true, twoFaLastAcceptedCounter: true },
  });

  // Any mismatch is a generic auth failure; do not leak "2FA not enabled" etc.
  if (!user || !user.twoFaEnabled || !user.twoFaSecret) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  const decrypt = deps?.decryptTwoFaSecret ?? decryptTwoFaSecret;
  const totpSecret = decrypt({ encryptedSecret: user.twoFaSecret, sharedSecret });
  const now = deps?.now ? deps.now() : new Date();

  let matchedCounter = (deps?.findMatchingTotpCounter ?? findMatchingTotpCounter)({
    secret: totpSecret,
    code: params.code,
    now,
  });

  if (
    matchedCounter === null &&
    deps?.verifyTotpCode?.({ secret: totpSecret, code: params.code, now })
  ) {
    matchedCounter = Math.floor(now.getTime() / 1000 / 30);
  }

  if (matchedCounter === null) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  if (matchedCounter <= (user.twoFaLastAcceptedCounter ?? -1)) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  const updated = await prisma.user.updateMany({
    where: {
      id: params.userId,
      OR: [
        { twoFaLastAcceptedCounter: null },
        { twoFaLastAcceptedCounter: { lt: matchedCounter } },
      ],
    },
    data: { twoFaLastAcceptedCounter: matchedCounter },
  });

  if (updated.count !== 1) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}
