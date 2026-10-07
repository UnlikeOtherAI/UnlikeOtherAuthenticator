import { decodeJwt } from 'jose';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient, RefreshToken } from '@prisma/client';
import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { normalizeDomain } from '../utils/domain.js';
import { adminConfigUrl } from './admin-auth-config.service.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';

const fail = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
export function adminSessionCookieName(accessToken: string): string {
  return `uoa_admin_session_${createHash('sha256').update(accessToken).digest('hex')}`;
}
export function adminBearer(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ') || value.includes(',')) throw fail();
  return value.slice(7);
}
export function adminDebugContext() {
  const domain = normalizeDomain(getAdminAuthDomain(getEnv()));
  return { domain, clientId: `admin:${domain}`, configUrl: adminConfigUrl() };
}
export function assertAdminDebugOrigin(request: FastifyRequest): void {
  const canonical = new URL(adminConfigUrl());
  const query = request.query as Record<string, unknown>;
  if (query.config_url !== canonical.toString() || request.headers.origin !== canonical.origin) throw fail();
  if (!request.headers['content-type']?.startsWith('application/json')) throw fail();
}
export function assertAdminDebugRequest(request: FastifyRequest): void {
  assertAdminDebugOrigin(request);
  if (!request.config || request.configUrl !== adminConfigUrl()
    || normalizeDomain(request.config.domain) !== adminDebugContext().domain) throw fail();
}
export function readAdminSource(request: FastifyRequest): string {
  const value = request.cookies[adminSessionCookieName(adminBearer(request))];
  if (!value) throw fail();
  return value;
}
export async function assertAdminDebugAuthority(source: RefreshToken, prisma: PrismaClient, expectedUserId?: string) {
  const context = adminDebugContext();
  if (source.domain !== context.domain || source.clientId !== context.clientId || source.configUrl !== context.configUrl
    || (expectedUserId && source.userId !== expectedUserId)) throw fail();
  const [user, role] = await Promise.all([
    prisma.user.findUnique({ where: { id: source.userId }, select: { lifecycleStatus: true } }),
    prisma.domainRole.findUnique({ where: { domain_userId: { domain: context.domain, userId: source.userId } },
      select: { role: true } }),
  ]);
  if (user?.lifecycleStatus !== 'ACTIVE' || role?.role !== 'SUPERUSER') throw fail();
}
export async function storeAdminSessionHandle(pair: {
  accessToken: string; refreshToken: string; expiresInSeconds: number;
}, prisma: PrismaClient, reply: FastifyReply): Promise<void> {
  const expiresAt = new Date(Number(decodeJwt(pair.accessToken).exp) * 1000);
  await prisma.refreshToken.updateMany({ where: {
    tokenHash: hashRefreshToken(pair.refreshToken, getEnv().SHARED_SECRET), expiresAt: { gt: expiresAt },
  }, data: { expiresAt } });
  reply.setCookie(adminSessionCookieName(pair.accessToken), pair.refreshToken, {
    httpOnly: true, secure: new URL(adminConfigUrl()).protocol === 'https:', sameSite: 'strict',
    path: '/internal/admin', maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}
export function clearAdminSessionHandle(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(adminSessionCookieName(adminBearer(request)), { path: '/internal/admin' });
}
