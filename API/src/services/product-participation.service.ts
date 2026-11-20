import { Prisma } from '@prisma/client';
import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

export async function assertProductParticipation(db: Pick<Prisma.TransactionClient, '$queryRaw'>, subject: string, domain: string, nativeApp?: string) {
  const env = getEnv();
  const clientDomain = normalizeDomain(domain);
  const shared = clientDomain === getAdminAuthDomain(env) || clientDomain === normalizeDomain(env.MCP_OAUTH_DOMAIN ?? '');
  if (!env.DATABASE_URL || (shared && !nativeApp)) return false;
  const rows = await db.$queryRaw<{ denied: boolean; bootstrap_closed: boolean }[]>(Prisma.sql`SELECT * FROM product_erasure_admission(${subject}, ${shared ? '' : clientDomain}, ${nativeApp ?? ''})`);
  if (rows[0]?.denied !== false) throw new AppError('FORBIDDEN', 403, 'PRODUCT_ACCOUNT_DELETED');
  return rows[0].bootstrap_closed;
}
