import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../services/access-token.service.js';

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function resolveDomainFromRequest(request: FastifyRequest): string {
  const queryDomain = typeof request.query === 'object' && request.query !== null
    ? (request.query as { domain?: unknown }).domain
    : undefined;
  const normalizedQueryDomain =
    typeof queryDomain === 'string' ? normalizeDomain(queryDomain) : undefined;

  const configDomain = typeof request.config?.domain === 'string' ? normalizeDomain(request.config.domain) : undefined;
  return normalizedQueryDomain || configDomain || '';
}

function resolveOrgIdFromParams(request: FastifyRequest): string | undefined {
  const params = request.params as { orgId?: string } | undefined;
  if (!params?.orgId) return undefined;
  const orgId = params.orgId.trim();
  return orgId || undefined;
}

export function parseBearerOrRawToken(value: unknown): string | null {
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

function normalizeOrgId(value: string): string {
  return value.trim();
}

export function requireOrgRole(...requiredRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply;

    const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
    if (!token) {
      throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
    }

    const claims = await verifyAccessToken(token);
    const domain = resolveDomainFromRequest(request);
    if (normalizeDomain(claims.domain) !== domain) {
      throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
    }

    const orgId = resolveOrgIdFromParams(request);
    if (requiredRoles.length > 0) {
      const memberOrgId = normalizeOrgId(claims.org?.org_id ?? '');
      if (!memberOrgId || !claims.org?.org_role) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }

      if (orgId && normalizeOrgId(memberOrgId) !== orgId) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }

      if (!requiredRoles.includes(claims.org.org_role)) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }
    } else if (orgId) {
      const memberOrgId = normalizeOrgId(claims.org?.org_id ?? '');
      if (!memberOrgId || memberOrgId !== orgId) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }
    }

    request.accessTokenClaims = claims;
  };
}
