import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { revokeAllRefreshTokensForUser } from './refresh-token-revocation.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';

type DisablePrisma = PrismaClient;

type DisableDeps = {
  afterRefreshSessionLock?: () => Promise<void>;
  beforeRefreshSessionLock?: () => Promise<void>;
  prisma?: DisablePrisma;
  revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser;
  verifyTwoFactorForLogin?: typeof verifyTwoFactorForLogin;
};

function adminPrisma(deps?: { prisma?: DisablePrisma }): DisablePrisma {
  return deps?.prisma ?? getAdminPrisma();
}

async function clearTwoFactor(userId: string, prisma: DisablePrisma): Promise<void> {
  const updated = await prisma.user.updateMany({
    where: { id: userId, twoFaEnabled: true },
    data: {
      twoFaEnabled: false,
      twoFaSecret: null,
      twoFaLastAcceptedCounter: null,
    },
  });

  if (updated.count !== 1) {
    throw new AppError('BAD_REQUEST', 400, 'TWOFA_DISABLE_FAILED');
  }
}

async function resetTwoFactor(userId: string, prisma: DisablePrisma): Promise<void> {
  const updated = await prisma.user.updateMany({
    where: { id: userId },
    data: {
      twoFaEnabled: false,
      twoFaSecret: null,
      twoFaLastAcceptedCounter: null,
    },
  });

  if (updated.count !== 1) {
    throw new AppError('BAD_REQUEST', 400, 'TWOFA_RESET_FAILED');
  }
}

export async function disableTwoFactorForUser(
  params: { userId: string; code: string },
  deps?: DisableDeps,
): Promise<void> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = adminPrisma(deps);
  await runInTransaction(prisma, async (tx) => {
    await deps?.beforeRefreshSessionLock?.();
    await lockRefreshSessionUser(params.userId, { prisma: tx });
    await deps?.afterRefreshSessionLock?.();
    await (deps?.verifyTwoFactorForLogin ?? verifyTwoFactorForLogin)(
      { userId: params.userId, code: params.code },
      { prisma: tx },
    );
    await clearTwoFactor(params.userId, tx);
    await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(params.userId, {
      prisma: tx,
    });
  });
}

export async function resetTwoFactorForUser(
  params: { userId: string },
  deps?: {
    afterRefreshSessionLock?: () => Promise<void>;
    beforeRefreshSessionLock?: () => Promise<void>;
    prisma?: DisablePrisma;
    revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser;
  },
): Promise<void> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = adminPrisma(deps);
  await runInTransaction(prisma, async (tx) => {
    await deps?.beforeRefreshSessionLock?.();
    await lockRefreshSessionUser(params.userId, { prisma: tx });
    await deps?.afterRefreshSessionLock?.();
    await resetTwoFactor(params.userId, tx);
    await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(params.userId, {
      prisma: tx,
    });
  });
}
