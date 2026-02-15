import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';
import { verifyAccessToken } from '../services/access-token.service.js';

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

export function requireOrgRole(...requiredRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply;

    const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
    if (!token) {
      throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
    }

    const claims = await verifyAccessToken(token);

    if (normalizeDomain(claims.domain) !== normalizeDomain(request.config!.domain)) {
      throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
    }

    if (requiredRoles.length > 0) {
      if (!claims.org?.org_role || !requiredRoles.includes(claims.org.org_role)) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }
    }

    request.accessTokenClaims = claims;
  };
}
