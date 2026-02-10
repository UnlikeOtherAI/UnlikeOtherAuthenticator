import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { encryptTwoFaSecret } from '../utils/twofa-secret.js';
import { verifyTotpCode } from './totp.service.js';

type EnrollPrisma = {
  user: {
    updateMany: (args: {
      where: { id: string; twoFaEnabled: boolean };
      data: { twoFaEnabled: boolean; twoFaSecret: string };
    }) => Promise<{ count: number }>;
    findUnique: (args: {
      where: { id: string };
      select: { id: true; twoFaEnabled: true };
    }) => Promise<{ id: string; twoFaEnabled: boolean } | null>;
  };
};

type EnrollDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: EnrollPrisma;
  sharedSecret?: string;
  verifyTotpCode?: typeof verifyTotpCode;
  encryptTwoFaSecret?: typeof encryptTwoFaSecret;
};

/**
 * Brief 13 / Phase 8.5: after verifying the initial TOTP code, mark 2FA enabled
 * and store the encrypted secret on the user record.
 */
export async function enrollTwoFactorForUser(
  params: { userId: string; totpSecret: string; code: string },
  deps?: EnrollDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  // `SHARED_SECRET` is required at process level, but unit tests inject `env`.
  const sharedSecret = deps?.sharedSecret ?? env.SHARED_SECRET;
  const verify = deps?.verifyTotpCode ?? verifyTotpCode;
  const ok = verify({ secret: params.totpSecret, code: params.code });
  if (!ok) {
    // Treat as generic authentication failure; never leak "wrong 2FA code" etc.
    throw new AppError('UNAUTHORIZED', 401, 'TWOFA_ENROLL_FAILED');
  }

  const encrypt = deps?.encryptTwoFaSecret ?? encryptTwoFaSecret;
  const encrypted = encrypt({ secret: params.totpSecret, sharedSecret });

  const prisma = deps?.prisma ?? (getPrisma() as unknown as EnrollPrisma);

  const updated = await prisma.user.updateMany({
    where: { id: params.userId, twoFaEnabled: false },
    data: { twoFaEnabled: true, twoFaSecret: encrypted },
  });

  if (updated.count === 1) return;

  const existing = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, twoFaEnabled: true },
  });

  if (!existing) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');
  if (existing.twoFaEnabled) throw new AppError('BAD_REQUEST', 400, 'TWOFA_ALREADY_ENABLED');

  throw new AppError('INTERNAL', 500, 'TWOFA_ENROLL_UPDATE_FAILED');
}
