import type { FastifyRequest } from 'fastify';

import { parseBearerOrRawToken } from '../utils/bearer-token.js';
import { AppError } from '../utils/errors.js';

type KeyBuilder = (request: FastifyRequest) => string;

type RateLimitOptions = {
  keyBuilder: KeyBuilder;
  /**
   * A fixed ceiling, or one resolved per request when a route's callers are not
   * all the same kind of principal — e.g. an end user versus the tenant's own
   * backend, whose budgets have nothing to do with each other.
   */
  limit: number | ((request: FastifyRequest) => number);
  windowMs: number;
};

// Keyed limiters are consumed with an explicit key by their caller, which has no
// request to resolve a per-request ceiling from — so their limit stays fixed.
type KeyedRateLimitOptions = { limit: number; windowMs: number };

type WindowState = {
  count: number;
  resetAt: number;
  pending?: number;
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

function consume(key: string, limit: number, windowMs: number) {
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
}

export function createKeyedRateLimiter({ limit, windowMs }: KeyedRateLimitOptions) {
  return function keyedRateLimiter(key: string) {
    consume(key, limit, windowMs);
  };
}

/** Count unsuccessful authentication, preserving multi-step successful native
 * flows. Same bounded expiring store as the existing account/IP limiters. */
export function createFailureRateLimiter({ limit, windowMs }: KeyedRateLimitOptions) {
  return {
    assertAllowed(key: string) {
      const state = windows.get(key);
      if (key && state && state.resetAt > Date.now() && state.count + (state.pending ?? 0) >= limit) throw new AppError('RATE_LIMITED', 429);
    },
    recordFailure(key: string) { consume(key, limit, windowMs); },
    beginAttempt(key: string) {
      if (!key) return (_failed = false) => {};
      const now = Date.now();
      let state = windows.get(key);
      if (!state || state.resetAt <= now) {
        ensureCapacity(now);
        state = { count: 0, pending: 0, resetAt: now + windowMs };
        windows.set(key, state);
      }
      if (state.count + (state.pending ?? 0) >= limit) throw new AppError('RATE_LIMITED', 429);
      state.pending = (state.pending ?? 0) + 1;
      const reserved = state;
      let finished = false;
      return (failed = false) => {
        if (finished) return;
        finished = true;
        reserved.pending = (reserved.pending ?? 1) - 1;
        if (failed) reserved.count += 1;
      };
    },
  };
}

export function createRateLimiter({ keyBuilder, limit, windowMs }: RateLimitOptions) {
  return async function rateLimiter(request: FastifyRequest) {
    consume(keyBuilder(request), typeof limit === 'function' ? limit(request) : limit, windowMs);
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
