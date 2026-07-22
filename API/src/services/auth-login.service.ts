import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { verifyPassword } from './password.service.js';
import { buildUserIdentity } from './user-scope.service.js';
import { AppError } from '../utils/errors.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';

type LoginPrisma = {
  $queryRaw: PrismaClient['$queryRaw'];
  user: {
    findUnique: (args: {
      where: { userKey: string };
      select: { id: true; passwordHash: true; twoFaEnabled: true; tokenVersion: true };
    }) => Promise<{
      id: string;
      passwordHash: string | null;
      twoFaEnabled: boolean;
      tokenVersion: number;
    } | null>;
  };
};

type LoginDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: LoginPrisma;
  verifyPassword?: typeof verifyPassword;
  buildUserIdentity?: typeof buildUserIdentity;
};

export async function loginWithEmailPassword(
  params: {
    email: string;
    password: string;
    config: ClientConfig;
  },
  deps?: LoginDeps,
): Promise<{ userId: string; twoFaEnabled: boolean; credentialEpoch: number }> {
  const env = deps?.env ?? getEnv();

  if (!env.DATABASE_URL) {
    // Keep this generic. Missing DB is an internal configuration error, but never leak details.
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const identityBuilder = deps?.buildUserIdentity ?? buildUserIdentity;
  const { userKey } = identityBuilder({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? (getPrisma() as unknown as LoginPrisma);
  const user = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true, passwordHash: true, twoFaEnabled: true, tokenVersion: true },
  });

  const ok = await (deps?.verifyPassword ?? verifyPassword)(
    params.password,
    user?.passwordHash ?? null,
  );

  if (!ok || !user) {
    // Brief 22.11 + 11: never reveal whether email exists, password was wrong, etc.
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  // Password verification discovers the stable lock identity. Re-read and, if
  // the hash changed while waiting, verify the current credential under the
  // canonical user hierarchy before snapshotting epoch/enrollment state.
  await lockRefreshSessionUserDomain(
    { userId: user.id, domain: params.config.domain },
    { prisma: prisma as unknown as PrismaClient },
  );
  const lockedUser = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true, passwordHash: true, twoFaEnabled: true, tokenVersion: true },
  });
  if (!lockedUser || lockedUser.id !== user.id) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  if (
    lockedUser.passwordHash !== user.passwordHash &&
    !(await (deps?.verifyPassword ?? verifyPassword)(params.password, lockedUser.passwordHash))
  ) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  return {
    userId: lockedUser.id,
    twoFaEnabled: lockedUser.twoFaEnabled,
    credentialEpoch: lockedUser.tokenVersion,
  };
}
