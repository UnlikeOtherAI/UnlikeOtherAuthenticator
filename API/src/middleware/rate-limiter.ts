import type { FastifyRequest } from 'fastify';

import { parseBearerOrRawToken } from './org-role-guard.js';
import { AppError } from '../utils/errors.js';

type KeyBuilder = (request: FastifyRequest) => string;

type RateLimitOptions = {
  keyBuilder: KeyBuilder;
  limit: number;
  windowMs: number;
};

type WindowState = {
  count: number;
  resetAt: number;
};

const windows = new Map<string, WindowState>();

function cleanUp() {
  const now = Date.now();
  for (const [key, window] of windows.entries()) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}

export function createRateLimiter({ keyBuilder, limit, windowMs }: RateLimitOptions) {
  return async function rateLimiter(request: FastifyRequest) {
    const key = keyBuilder(request);
    if (!key) {
      return;
    }

    cleanUp();
    const now = Date.now();
    const existing = windows.get(key);

    if (!existing || existing.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }

    existing.count += 1;
    windows.set(key, existing);

    if (existing.count > limit) {
      throw new AppError('RATE_LIMITED', 429);
    }
  };
}

export function createUserDomainRateLimitKey(prefix: string, domain?: string, request?: FastifyRequest) {
  if (!domain || !request) {
    return `${prefix}:anonymous`;
  }

  const token = parseBearerOrRawToken(
    request.headers['x-uoa-access-token'] ||
      request.headers['X-UOA-Access-Token'] ||
      request.headers['x-uoa-access-token'],
  );

  return `${prefix}:${domain}:${token ?? 'anonymous'}`;
}
