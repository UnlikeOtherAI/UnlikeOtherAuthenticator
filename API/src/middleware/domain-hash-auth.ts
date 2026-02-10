import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { createClientId } from '../utils/hash.js';

function parseBearerToken(headerValue: unknown): string | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('bearer ')) return null;

  const token = trimmed.slice('bearer '.length).trim();
  return token ? token : null;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Brief 22.13: token exchange must be completed by the client backend, not the browser.
 *
 * Require a domain-hash bearer token (hash(domain + shared secret)) so the frontend
 * cannot call `/auth/token` directly.
 */
export async function requireDomainHashAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const config = request.config;
  if (!config) {
    // configVerifier should have attached this; fail closed.
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
  }

  const provided = parseBearerToken(request.headers.authorization);
  if (!provided) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_DOMAIN_HASH_TOKEN');
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const expected = createClientId(config.domain, SHARED_SECRET);

  if (!safeEqual(provided, expected)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_DOMAIN_HASH_TOKEN');
  }
}

/**
 * Brief 17: domain-scoped APIs require a bearer token = hash(domain + shared secret).
 *
 * These endpoints don't necessarily run through config verification, so we bind the token
 * to an explicit `?domain=...` query parameter.
 */
export async function requireDomainHashAuthForDomainQuery(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const provided = parseBearerToken(request.headers.authorization);
  if (!provided) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_DOMAIN_HASH_TOKEN');
  }

  const domain = (request.query as { domain?: unknown } | undefined)?.domain;
  if (typeof domain !== 'string' || !domain.trim()) {
    throw new AppError('BAD_REQUEST', 400, 'MISSING_DOMAIN');
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const expected = createClientId(domain, SHARED_SECRET);

  if (!safeEqual(provided, expected)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_DOMAIN_HASH_TOKEN');
  }
}
