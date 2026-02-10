import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../services/access-token.service.js';

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function parseBearerOrRawToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bearer ')) {
    const token = trimmed.slice('bearer '.length).trim();
    return token ? token : null;
  }

  return trimmed;
}

declare module 'fastify' {
  interface FastifyRequest {
    accessTokenClaims?: AccessTokenClaims;
  }
}

/**
 * Brief 12.4: debug endpoints are superuser-only.
 *
 * Domain-scoped APIs use Authorization: Bearer <domain-hash>, so we accept a
 * separate access token header for role-based authorization.
 */
export async function requireSuperuserAccessTokenForDomainQuery(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
  if (!token) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  const claims = await verifyAccessToken(token);

  const domainValue = (request.query as { domain?: unknown } | undefined)?.domain;
  if (typeof domainValue !== 'string' || !domainValue.trim()) {
    throw new AppError('BAD_REQUEST', 400, 'MISSING_DOMAIN');
  }
  const domain = normalizeDomain(domainValue);

  if (normalizeDomain(claims.domain) !== domain) {
    throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
  }

  if (claims.role !== 'superuser') {
    throw new AppError('FORBIDDEN', 403, 'NOT_SUPERUSER');
  }

  request.accessTokenClaims = claims;
}
