import { PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';

let prisma: PrismaClient | undefined;
let adminPrisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (prisma) return prisma;

  const { DATABASE_URL } = requireEnv('DATABASE_URL');
  prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  });
  return prisma;
}

// Bootstrap / admin Prisma client. Used by every DB access path that runs without tenant context:
// domain-hash auth, admin-superuser middleware, config-verifier JWK lookup, /.well-known/jwks.json,
// auto-onboarding discovery, /internal/admin/*, /integrations/claim/*, retention pruning,
// and audit-log writes. Connects as the BYPASSRLS role (uoa_admin) in production.
//
// Falls back to DATABASE_URL when DATABASE_ADMIN_URL is unset so that local/dev without RLS keeps
// working unchanged.
export function getAdminPrisma(): PrismaClient {
  if (adminPrisma) return adminPrisma;

  const env = getEnv();
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new Error('getAdminPrisma(): neither DATABASE_ADMIN_URL nor DATABASE_URL is set');
  }

  adminPrisma = new PrismaClient({
    datasources: { db: { url } },
  });
  return adminPrisma;
}

export async function connectPrisma(): Promise<void> {
  await getPrisma().$connect();
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
  if (adminPrisma) {
    await adminPrisma.$disconnect();
    adminPrisma = undefined;
  }
}
