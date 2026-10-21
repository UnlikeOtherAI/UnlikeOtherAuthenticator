import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';

type RetentionPrisma = {
  telephoneCallChallenge: Pick<PrismaClient['telephoneCallChallenge'], 'deleteMany'>;
  telephoneChallenge: Pick<PrismaClient['telephoneChallenge'], 'deleteMany'>;
  telephoneSmsAdmission: Pick<PrismaClient['telephoneSmsAdmission'], 'deleteMany'>;
  telephoneLookup: Pick<PrismaClient['telephoneLookup'], 'deleteMany'>;
  debugLoginGrant: Pick<PrismaClient['debugLoginGrant'], 'deleteMany'>;
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
  telephoneCallChallengesDeleted: number;
  telephoneChallengesDeleted: number;
  telephoneSmsAdmissionsDeleted: number;
  telephoneLookupsDeleted: number;
  debugLoginGrantsDeleted: number;
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
    telephoneCallChallengesDeleted: 0,
    telephoneChallengesDeleted: 0,
    telephoneSmsAdmissionsDeleted: 0,
    telephoneLookupsDeleted: 0,
    debugLoginGrantsDeleted: 0,
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
    telephoneCallChallenges,
    telephoneChallenges,
    telephoneSmsAdmissions,
    telephoneLookups,
    debugLoginGrants,
    refreshTokens,
    authorizationCodes,
    confidentialAssertionUses,
    loginSessionUses,
    verificationTokens,
    loginLogs,
    handshakeErrorLogs,
  ] = await Promise.all([
    prisma.telephoneCallChallenge.deleteMany({ where: { createdAt: { lt: subtractDays(now, 1) } } }),
    prisma.telephoneChallenge.deleteMany({ where: { createdAt: { lt: subtractDays(now, 1) } } }),
    prisma.telephoneSmsAdmission.deleteMany({ where: { createdAt: { lt: subtractDays(now, 30) } } }),
    prisma.telephoneLookup.deleteMany({ where: { createdAt: { lt: subtractDays(now, 30) } } }),
    prisma.debugLoginGrant.deleteMany({ where: { expiresAt: { lt: now } } }),
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
    telephoneCallChallengesDeleted: telephoneCallChallenges.count,
    telephoneChallengesDeleted: telephoneChallenges.count,
    telephoneSmsAdmissionsDeleted: telephoneSmsAdmissions.count,
    telephoneLookupsDeleted: telephoneLookups.count,
    debugLoginGrantsDeleted: debugLoginGrants.count,
    authorizationCodesDeleted: authorizationCodes.count,
    confidentialAssertionUsesDeleted: confidentialAssertionUses.count,
    handshakeErrorLogsDeleted: handshakeErrorLogs.count,
    loginSessionUsesDeleted: loginSessionUses.count,
    loginLogsDeleted: loginLogs.count,
    refreshTokensDeleted: refreshTokens.count,
    verificationTokensDeleted: verificationTokens.count,
  };
}
