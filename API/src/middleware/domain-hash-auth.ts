import type { FastifyRequest } from 'fastify';

import { verifyDomainAuthToken } from '../services/domain-secret.service.js';
import { AppError } from '../utils/errors.js';

type RequestWithConfig = FastifyRequest & {
  config?: {
    domain?: string;
  };
};

declare module 'fastify' {
  interface FastifyRequest {
    domainAuthClientId?: string;
  }
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

function resolveVerifiedConfigDomain(request: RequestWithConfig): string | undefined {
  const configDomain = normaliseDomain(request.config?.domain);
  const queryDomain = (request.query as { domain?: unknown } | undefined)?.domain;
  const normalizedQueryDomain = normaliseDomain(queryDomain);

  if (configDomain && normalizedQueryDomain && normalizedQueryDomain !== configDomain) {
    throw new AppError('UNAUTHORIZED', 401);
  }

  return configDomain;
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

  return token.toLowerCase().startsWith('bearer ') ? token.slice('bearer '.length).trim() : token;
}

async function domainHashAuth(request: RequestWithConfig) {
  const domain = resolveDomain(request);
  if (!domain) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await verifyDomainHashAuth(request, domain);
}

async function domainHashAuthForVerifiedConfig(request: RequestWithConfig) {
  const domain = resolveVerifiedConfigDomain(request);
  if (!domain) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await verifyDomainHashAuth(request, domain);
}

async function verifyDomainHashAuth(request: FastifyRequest, domain: string) {
  const token = parseAuthHeader(getAuthorizationToken(request));

  if (!token) {
    throw new AppError('UNAUTHORIZED', 401);
  }

  const result = await verifyDomainAuthToken({ domain, token });
  request.domainAuthClientId = result.clientId;
}

export function requireDomainHashAuthForDomainQuery(): typeof domainHashAuth;
export function requireDomainHashAuthForDomainQuery(request: RequestWithConfig): Promise<void>;
export function requireDomainHashAuthForDomainQuery(
  request?: RequestWithConfig,
): Promise<void> | typeof domainHashAuth {
  if (request) {
    return domainHashAuth(request);
  }

  return domainHashAuth;
}

export const requireDomainHashAuth = (request: RequestWithConfig): Promise<void> => {
  return domainHashAuthForVerifiedConfig(request);
};

export default requireDomainHashAuthForDomainQuery;
