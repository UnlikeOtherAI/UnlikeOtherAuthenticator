/**
 * Domain hash auth — middleware contract
 *
 * This module exposes two guards. They are NOT interchangeable; pick the one
 * that matches the trust source the route actually has.
 *
 * 1) `requireDomainHashAuthForDomainQuery` (default export)
 *    - Intended for routes that take `?domain=<host>` as a query parameter and
 *      have NOT yet verified a signed config (i.e. `configVerifier` has not
 *      run, or runs AFTER this guard).
 *    - Domain resolution order: `request.query.domain` first; falls back to
 *      `request.config?.domain` only if the query did not supply one. In
 *      practice every current caller supplies the query param up-front and the
 *      fallback never fires, but the fallback is preserved as a safety net for
 *      future post-config callers.
 *    - The domain is NOT read from URL path params anywhere — claims of a
 *      `:domain` path-param source are incorrect.
 *
 * 2) `requireDomainHashAuth`
 *    - Intended for routes where `configVerifier` has already run and the
 *      verified config carries the trusted domain. The bearer token in
 *      `Authorization` is checked against that verified domain.
 *    - If the request also passes `?domain=`, it must match the verified
 *      config domain exactly, otherwise the request is rejected with 401.
 *      This prevents an attacker from confusing the two trust sources.
 *
 * Both helpers share `verifyDomainHashAuth`, which performs the actual
 * digest comparison via `verifyDomainAuthToken` in
 * `services/domain-secret.service.ts`. The security-relevant comparison logic
 * (constant-time hex equality) lives there, NOT in this file.
 */
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
