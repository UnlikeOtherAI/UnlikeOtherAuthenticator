import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';

type RetentionPrisma = {
  authorizationCode: Pick<PrismaClient['authorizationCode'], 'deleteMany'>;
  confidentialAssertionUse: Pick<PrismaClient['confidentialAssertionUse'], 'deleteMany'>;
  handshakeErrorLog: Pick<PrismaClient['handshakeErrorLog'], 'deleteMany'>;
  loginSessionUse: Pick<PrismaClient['loginSessionUse'], 'deleteMany'>;
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
  confidentialAssertionUsesDeleted: number;
  handshakeErrorLogsDeleted: number;
  loginSessionUsesDeleted: number;
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
    confidentialAssertionUsesDeleted: 0,
    handshakeErrorLogsDeleted: 0,
    loginSessionUsesDeleted: 0,
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

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as RetentionPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const tokenCutoff = subtractDays(now, env.TOKEN_PRUNE_RETENTION_DAYS);
  const loginLogCutoff = subtractDays(now, env.LOG_RETENTION_DAYS);

  const [
    refreshTokens,
    authorizationCodes,
    confidentialAssertionUses,
    loginSessionUses,
    verificationTokens,
    loginLogs,
    handshakeErrorLogs,
  ] = await Promise.all([
    prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: tokenCutoff } },
    }),
    prisma.authorizationCode.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.confidentialAssertionUse.deleteMany({
      where: { expiresAt: { lte: now } },
    }),
    prisma.loginSessionUse.deleteMany({
      where: { expiresAt: { lte: now } },
    }),
    prisma.verificationToken.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.loginLog.deleteMany({
      where: { createdAt: { lt: loginLogCutoff } },
    }),
    prisma.handshakeErrorLog.deleteMany({
      where: { createdAt: { lt: loginLogCutoff } },
    }),
  ]);

  return {
    authorizationCodesDeleted: authorizationCodes.count,
    confidentialAssertionUsesDeleted: confidentialAssertionUses.count,
    handshakeErrorLogsDeleted: handshakeErrorLogs.count,
    loginSessionUsesDeleted: loginSessionUses.count,
    loginLogsDeleted: loginLogs.count,
    refreshTokensDeleted: refreshTokens.count,
    verificationTokensDeleted: verificationTokens.count,
  };
}
