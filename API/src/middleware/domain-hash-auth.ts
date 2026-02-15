import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../utils/errors.js';

type RequestWithConfig = FastifyRequest & {
  config?: {
    domain?: string;
  };
};

function getSecret() {
  const secret = process.env.SHARED_SECRET;
  if (!secret?.trim()) {
    throw new AppError('Missing shared secret', 500);
  }
  return secret;
}

function normaliseDomain(rawDomain: unknown) {
  if (typeof rawDomain !== 'string') {
    return undefined;
  }

  const value = rawDomain.trim().toLowerCase();
  return value || undefined;
}

function resolveDomain(request: FastifyRequest): string | undefined {
  const queryDomain = (request.query as { domain?: unknown } | undefined)?.domain;
  return normaliseDomain(queryDomain) || normaliseDomain(request.config?.domain);
}

function getAuthorizationToken(request: FastifyRequest) {
  const token = request.headers.authorization;
  if (token !== undefined) return token;

  const fallback = request.headers.Authorization;
  return typeof fallback === 'string' ? fallback : undefined;
}

function parseAuthHeader(value: unknown) {
  if (!value) {
    return undefined;
  }

  const asString = Array.isArray(value) ? value[0] : value;
  const token = asString?.trim();
  if (!token) {
    return undefined;
  }

  return token.toLowerCase().startsWith('bearer ')
    ? token.slice('bearer '.length).trim()
    : token;
}

function expectedDomainHash(domain: string, secret: string) {
  return createHash('sha256').update(`${domain}${secret}`).digest('hex');
}

async function domainHashAuth(request: RequestWithConfig) {
  const domain = resolveDomain(request);
  if (!domain) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const token = parseAuthHeader(getAuthorizationToken(request));

  if (!token) {
    throw new AppError('UNAUTHORIZED', 401);
  }

  const secret = getSecret();
  const expected = expectedDomainHash(domain, secret);

  if (token !== expected) {
    throw new AppError('UNAUTHORIZED', 401);
  }
}

export function requireDomainHashAuthForDomainQuery(request?: RequestWithConfig): any {
  if (request) {
    return domainHashAuth(request);
  }

  return domainHashAuth;
}

export const requireDomainHashAuth = (
  request: RequestWithConfig,
): Promise<void> => {
  return requireDomainHashAuthForDomainQuery(request);
};

export default requireDomainHashAuthForDomainQuery;
