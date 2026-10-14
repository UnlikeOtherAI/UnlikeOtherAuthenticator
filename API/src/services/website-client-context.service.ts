import type { PrismaClient } from '@prisma/client';
import { verifyDomainAuthToken } from './domain-secret.service.js';
import { matchesRefreshTokenContext, type RefreshTokenContext } from './refresh-token-replay.service.js';
import { getEnv } from '../config/env.js';
import { AppError, isAppError } from '../utils/errors.js';

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
    if (authority.clientId !== context.clientId) return false;
    if (getEnv().WEBSITE_CLIENT_CONTEXT_PHASE === 'stable') throw new AppError('SERVICE_UNAVAILABLE', 503, 'WEBSITE_CONTEXT_CUTOVER_REQUIRED');
    return true;
  } catch (error) {
    if (isAppError(error) && error.statusCode === 401) return false;
    throw error;
  }
}

/** Resolve storage separately from the public JWT identifier during the bridge.
 * Every pre-bridge reader still needs its original binding. No online rewrite. */
export async function websiteRefreshStorageClientId(context: RefreshTokenContext,
  credential: string | undefined, prisma: PrismaClient): Promise<string> {
  if (!credential || getEnv().WEBSITE_CLIENT_CONTEXT_PHASE === 'stable') return context.clientId;
  const binding = await verifyDomainAuthToken({ domain: context.domain, token: credential }, { prisma });
  if (binding.clientId !== context.clientId) throw new AppError('UNAUTHORIZED', 401);
  return credential;
}

/** Offline phase-two CLI only, never a request path. Called after product-policy and canonical refresh-session locks. Rewrite
 * the entire family and its debug grants together so replay edges stay coherent. */
export async function migrateWebsiteRefreshFamily(
  row: RefreshTokenContext & { familyId: string; userId: string },
  context: RefreshTokenContext, prisma: PrismaClient,
): Promise<void> {
  if (!legacy(row.clientId) || row.clientId === context.clientId) return;
  if (getEnv().WEBSITE_CLIENT_CONTEXT_PHASE !== 'stable') throw new AppError('SERVICE_UNAVAILABLE', 503, 'WEBSITE_CONTEXT_BRIDGE_ACTIVE');
  const authority = await verifyDomainAuthToken({ domain: row.domain, token: row.clientId }, { prisma });
  if (authority.clientId !== context.clientId || row.domain !== context.domain || row.configUrl !== context.configUrl) throw new AppError('UNAUTHORIZED', 401);
  const where = { familyId: row.familyId, userId: row.userId, domain: row.domain, clientId: row.clientId };
  await prisma.refreshToken.updateMany({ where, data: { clientId: context.clientId } });
  await prisma.debugLoginGrant.updateMany({ where: { sourceFamilyId: row.familyId,
    userId: row.userId, domain: row.domain, clientId: row.clientId }, data: { clientId: context.clientId } });
}
