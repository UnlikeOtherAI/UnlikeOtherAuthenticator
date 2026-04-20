import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { createRateLimiter } from '../../middleware/rate-limiter.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
type RateLimiter = ReturnType<typeof createRateLimiter>;

function getRequestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function normalizePart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hashPart(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function bodyString(request: FastifyRequest, key: string): string {
  const body =
    request.body && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>)
      : {};
  return normalizePart(body[key]);
}

function authIpKey(prefix: string, request: FastifyRequest): string {
  return `${prefix}:ip:${getRequestIp(request)}`;
}

function authBodyKey(prefix: string, request: FastifyRequest, key: string): string {
  const value = bodyString(request, key);
  return value ? `${prefix}:${key}:${hashPart(value)}` : '';
}

function composeRateLimiters(...limiters: RateLimiter[]): RateLimiter {
  return async function composedRateLimiter(request: FastifyRequest) {
    for (const limiter of limiters) {
      await limiter(request);
    }
  };
}

function ipRateLimiter(prefix: string, limit: number, windowMs: number): RateLimiter {
  return createRateLimiter({
    limit,
    windowMs,
    keyBuilder: (request) => authIpKey(prefix, request),
  });
}

function bodyRateLimiter(prefix: string, key: string, limit: number, windowMs: number): RateLimiter {
  return createRateLimiter({
    limit,
    windowMs,
    keyBuilder: (request) => authBodyKey(prefix, request, key),
  });
}

export const loginRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:login', 10, MINUTE_MS),
  bodyRateLimiter('auth:login', 'email', 5, 15 * MINUTE_MS),
);

export const registerRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:register', 10, MINUTE_MS),
  bodyRateLimiter('auth:register', 'email', 5, HOUR_MS),
);

export const resetRequestRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:reset-request', 10, MINUTE_MS),
  bodyRateLimiter('auth:reset-request', 'email', 3, HOUR_MS),
);

export const tokenConsumeRateLimiter = ipRateLimiter('auth:token-consume', 10, MINUTE_MS);

export const tokenExchangeRateLimiter = ipRateLimiter('auth:token-exchange', 10, MINUTE_MS);

export const twoFactorVerifyRateLimiter = ipRateLimiter('auth:twofa-verify', 5, 15 * MINUTE_MS);

export const socialCallbackRateLimiter = ipRateLimiter('auth:social-callback', 20, MINUTE_MS);
