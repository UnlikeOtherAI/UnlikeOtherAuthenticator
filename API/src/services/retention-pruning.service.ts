import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';

type RetentionPrisma = {
  authorizationCode: Pick<PrismaClient['authorizationCode'], 'deleteMany'>;
  loginLog: Pick<PrismaClient['loginLog'], 'deleteMany'>;
  refreshToken: Pick<PrismaClient['refreshToken'], 'deleteMany'>;
  verificationToken: Pick<PrismaClient['verificationToken'], 'deleteMany'>;
};

type RetentionPruneDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  prisma?: RetentionPrisma;
};

export type RetentionPruneResult = {
  authorizationCodesDeleted: number;
  loginLogsDeleted: number;
  refreshTokensDeleted: number;
  verificationTokensDeleted: number;
};

function subtractDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function emptyResult(): RetentionPruneResult {
  return {
    authorizationCodesDeleted: 0,
    loginLogsDeleted: 0,
    refreshTokensDeleted: 0,
    verificationTokensDeleted: 0,
  };
}

export async function pruneExpiredSecurityData(
  deps?: RetentionPruneDeps,
): Promise<RetentionPruneResult> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return emptyResult();

  const prisma = deps?.prisma ?? (getPrisma() as unknown as RetentionPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const tokenCutoff = subtractDays(now, env.TOKEN_PRUNE_RETENTION_DAYS);
  const loginLogCutoff = subtractDays(now, env.LOG_RETENTION_DAYS);

  const [refreshTokens, authorizationCodes, verificationTokens, loginLogs] = await Promise.all([
    prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: tokenCutoff } },
    }),
    prisma.authorizationCode.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.verificationToken.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.loginLog.deleteMany({
      where: { createdAt: { lt: loginLogCutoff } },
    }),
  ]);

  return {
    authorizationCodesDeleted: authorizationCodes.count,
    loginLogsDeleted: loginLogs.count,
    refreshTokensDeleted: refreshTokens.count,
    verificationTokensDeleted: verificationTokens.count,
  };
}
