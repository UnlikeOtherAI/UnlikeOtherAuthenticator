import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { decryptTwoFaSecret } from '../utils/twofa-secret.js';
import { verifyTotpCode } from './totp.service.js';

type TwoFaLoginPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
};

type TwoFaLoginDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: TwoFaLoginPrisma;
  sharedSecret?: string;
  decryptTwoFaSecret?: typeof decryptTwoFaSecret;
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
    select: { twoFaEnabled: true, twoFaSecret: true },
  });

  // Any mismatch is a generic auth failure; do not leak "2FA not enabled" etc.
  if (!user || !user.twoFaEnabled || !user.twoFaSecret) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  const decrypt = deps?.decryptTwoFaSecret ?? decryptTwoFaSecret;
  const totpSecret = decrypt({ encryptedSecret: user.twoFaSecret, sharedSecret });

  const verify = deps?.verifyTotpCode ?? verifyTotpCode;
  const ok = verify({
    secret: totpSecret,
    code: params.code,
    now: deps?.now ? deps.now() : undefined,
  });
  if (!ok) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}

