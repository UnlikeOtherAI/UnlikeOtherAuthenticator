import type { PrismaClient } from '@prisma/client';
import { verifyDomainAuthToken } from './domain-secret.service.js';
import { matchesRefreshTokenContext, type RefreshTokenContext } from './refresh-token-replay.service.js';
import { isAppError } from '../utils/errors.js';

const legacy = (value: string) => /^[a-f0-9]{64}$/i.test(value);

/** Read compatibility only. Authenticate a legacy stored binding without returning it.
 * This permits an online rollout before the explicit post-drain data cleanup. */
export async function matchesWebsiteRefreshContext(
  row: RefreshTokenContext, context: RefreshTokenContext, prisma: PrismaClient,
): Promise<boolean> {
  if (matchesRefreshTokenContext(row, context)) return true;
  if (!legacy(row.clientId) || row.domain !== context.domain || row.configUrl !== context.configUrl) return false;
  try {
    const authority = await verifyDomainAuthToken({ domain: row.domain, token: row.clientId }, { prisma });
    return authority.clientId === context.clientId;
  } catch (error) {
    if (isAppError(error) && error.statusCode === 401) return false;
    throw error;
  }
}

/** Called only after product-policy and canonical refresh-session locks. Rewrite
 * the entire family and its debug grants together so replay edges stay coherent. */
export async function migrateWebsiteRefreshFamily(
  row: RefreshTokenContext & { familyId: string; userId: string },
  context: RefreshTokenContext, prisma: PrismaClient,
): Promise<void> {
  if (!legacy(row.clientId) || row.clientId === context.clientId) return;
  if (!await matchesWebsiteRefreshContext(row, context, prisma)) return;
  const where = { familyId: row.familyId, userId: row.userId, domain: row.domain, clientId: row.clientId };
  await prisma.refreshToken.updateMany({ where, data: { clientId: context.clientId } });
  await prisma.debugLoginGrant.updateMany({ where: { sourceFamilyId: row.familyId,
    userId: row.userId, domain: row.domain, clientId: row.clientId }, data: { clientId: context.clientId } });
}
