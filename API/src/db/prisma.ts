import { PrismaClient } from '@prisma/client';

import { requireEnv } from '../config/env.js';

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (prisma) return prisma;

  const { DATABASE_URL } = requireEnv('DATABASE_URL');
  prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  });
  return prisma;
}

export async function connectPrisma(): Promise<void> {
  await getPrisma().$connect();
}

export async function disconnectPrisma(): Promise<void> {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = undefined;
}

