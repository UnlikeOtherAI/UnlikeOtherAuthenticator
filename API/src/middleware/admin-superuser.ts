import type { FastifyReply, FastifyRequest } from 'fastify';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { verifyAccessToken, type AccessTokenClaims } from '../services/access-token.service.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

function parseBearerToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;

  const token = trimmed.slice('bearer '.length).trim();
  return token || null;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminAccessTokenClaims?: AccessTokenClaims;
  }
}

export async function requireAdminSuperuser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const token = parseBearerToken(request.headers.authorization);
  if (!token) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  const env = getEnv();
  if (!env.ADMIN_ACCESS_TOKEN_SECRET) {
    throw new AppError('INTERNAL', 500, 'ADMIN_ACCESS_TOKEN_SECRET_REQUIRED');
  }

  const claims = await verifyAccessToken(token, { sharedSecret: env.ADMIN_ACCESS_TOKEN_SECRET });
  if (claims.role !== 'superuser') {
    throw new AppError('FORBIDDEN', 403, 'NOT_SUPERUSER');
  }

  const adminDomain = normalizeDomain(env.ADMIN_AUTH_DOMAIN ?? env.AUTH_SERVICE_IDENTIFIER);
  if (normalizeDomain(claims.domain) !== adminDomain) {
    throw new AppError('FORBIDDEN', 403, 'ADMIN_DOMAIN_MISMATCH');
  }

  if (env.DATABASE_URL) {
    const adminRole = await getPrisma().domainRole.findUnique({
      where: { domain_userId: { domain: adminDomain, userId: claims.userId } },
      select: { role: true },
    });
    if (adminRole?.role !== 'SUPERUSER') {
      throw new AppError('FORBIDDEN', 403, 'ADMIN_ROLE_NOT_GRANTED');
    }
  }

  request.adminAccessTokenClaims = claims;
}
