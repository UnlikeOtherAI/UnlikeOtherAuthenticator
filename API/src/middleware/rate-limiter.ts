import type { FastifyRequest } from 'fastify';

import { parseBearerOrRawToken } from './org-role-guard.js';
import { AppError } from '../utils/errors.js';

type KeyBuilder = (request: FastifyRequest) => string;

type RateLimitOptions = {
  keyBuilder: KeyBuilder;
  limit: number;
  windowMs: number;
};

type KeyedRateLimitOptions = Omit<RateLimitOptions, 'keyBuilder'>;

type WindowState = {
  count: number;
  resetAt: number;
};

const windows = new Map<string, WindowState>();

// Hard upper bound on tracked keys to prevent unbounded memory growth from
// body-keyed limiters (one entry per distinct email/token hash).
const MAX_ENTRIES = 100_000;
// How often the background sweep removes expired windows.
const SWEEP_INTERVAL_MS = 60_000;

function sweepExpired() {
  const now = Date.now();
  for (const [key, window] of windows.entries()) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}

// Periodic background sweep instead of an O(n) scan on every request.
// unref() so the timer never keeps the process alive (tests/process exit).
const sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// Make room for a new key while respecting MAX_ENTRIES. Evicts expired
// entries first; if still at the cap, evicts the oldest inserted entry
// (Map preserves insertion order, so the front is the oldest).
function ensureCapacity(now: number) {
  if (windows.size < MAX_ENTRIES) {
    return;
  }
  for (const [key, window] of windows.entries()) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
  while (windows.size >= MAX_ENTRIES) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    windows.delete(oldest);
  }
}

export function createKeyedRateLimiter({ limit, windowMs }: KeyedRateLimitOptions) {
  return function keyedRateLimiter(key: string) {
    if (!key) {
      return;
    }

    const now = Date.now();
    const existing = windows.get(key);

    if (!existing || existing.resetAt <= now) {
      ensureCapacity(now);
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

export function createRateLimiter({ keyBuilder, limit, windowMs }: RateLimitOptions) {
  const consume = createKeyedRateLimiter({ limit, windowMs });
  return async function rateLimiter(request: FastifyRequest) {
    consume(keyBuilder(request));
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
