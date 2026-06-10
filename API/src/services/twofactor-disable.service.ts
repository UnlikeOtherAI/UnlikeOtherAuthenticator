import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';

type DisablePrisma = Pick<PrismaClient, 'user'>;

type DisableDeps = {
  prisma?: DisablePrisma;
  revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser;
  verifyTwoFactorForLogin?: typeof verifyTwoFactorForLogin;
};

function tenantPrisma(deps?: DisableDeps): DisablePrisma {
  return deps?.prisma ?? (getPrisma() as unknown as DisablePrisma);
}

function adminPrisma(deps?: { prisma?: DisablePrisma }): DisablePrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as DisablePrisma);
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

  const prisma = tenantPrisma(deps);
  await (deps?.verifyTwoFactorForLogin ?? verifyTwoFactorForLogin)(
    { userId: params.userId, code: params.code },
    { prisma },
  );
  await clearTwoFactor(params.userId, prisma);
  await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(params.userId);
}

export async function resetTwoFactorForUser(
  params: { userId: string },
  deps?: { prisma?: DisablePrisma; revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser },
): Promise<void> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = adminPrisma(deps);
  await resetTwoFactor(params.userId, prisma);
  await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(params.userId);
}
