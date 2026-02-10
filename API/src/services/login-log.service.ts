import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';

type LoginLogPrisma = {
  loginLog: Pick<PrismaClient['loginLog'], 'create' | 'deleteMany' | 'findMany'>;
  user: Pick<PrismaClient['user'], 'findUnique'>;
};

type LoginLogDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: LoginLogPrisma;
  now?: () => Date;
};

export type LoginLogRecord = {
  id: string;
  userId: string;
  email: string;
  domain: string;
  authMethod: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
};

function computeRetentionCutoff(now: Date, retentionDays: number): Date {
  const ms = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

export async function pruneLoginLogs(deps?: LoginLogDeps): Promise<{ deletedCount: number }> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return { deletedCount: 0 };

  const prisma = deps?.prisma ?? (getPrisma() as unknown as LoginLogPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const cutoff = computeRetentionCutoff(now, env.LOG_RETENTION_DAYS);
  const result = await prisma.loginLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  return { deletedCount: result.count };
}

export async function recordLoginLog(
  params: {
    userId: string;
    email?: string;
    domain: string;
    authMethod: string;
    ip?: string | null;
    userAgent?: string | null;
  },
  deps?: LoginLogDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const prisma = deps?.prisma ?? (getPrisma() as unknown as LoginLogPrisma);
  const now = deps?.now ? deps.now() : new Date();

  let email = (params.email ?? '').trim().toLowerCase();
  if (!email) {
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { email: true },
    });
    if (!user) return;
    email = user.email.trim().toLowerCase();
  }

  await prisma.loginLog.create({
    data: {
      userId: params.userId,
      email,
      domain: params.domain,
      authMethod: params.authMethod,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      createdAt: now,
    },
    select: { id: true },
  });

  // Brief 22.8: log retention must be finite. Enforce it opportunistically on writes.
  await pruneLoginLogs({ env, prisma, now: () => now });
}

export async function listLoginLogsForDomain(
  params: { domain: string; limit?: number },
  deps?: LoginLogDeps,
): Promise<LoginLogRecord[]> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return [];

  const prisma = deps?.prisma ?? (getPrisma() as unknown as LoginLogPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const cutoff = computeRetentionCutoff(now, env.LOG_RETENTION_DAYS);

  const limit = Math.max(1, Math.min(500, params.limit ?? 100));

  return await prisma.loginLog.findMany({
    where: {
      domain: params.domain,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      email: true,
      domain: true,
      authMethod: true,
      ip: true,
      userAgent: true,
      createdAt: true,
    },
  });
}
