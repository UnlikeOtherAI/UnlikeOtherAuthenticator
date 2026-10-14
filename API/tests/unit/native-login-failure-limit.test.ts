import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFailureRateLimiter } from '../../src/middleware/rate-limiter.js';
afterEach(() => vi.useRealTimers());
describe('native authentication failure budget', () => {
  it('bounds wrong password/factor guesses without charging successful MFA continuation steps', () => {
    const key = randomUUID(); const limiter = createFailureRateLimiter({ limit: 5, windowMs: 900_000 });
    for (let attempt = 0; attempt < 4; attempt++) { limiter.assertAllowed(key); limiter.recordFailure(key); }
    for (let continuation = 0; continuation < 100; continuation++) expect(() => limiter.assertAllowed(key)).not.toThrow();
    limiter.recordFailure(key);
    expect(() => limiter.assertAllowed(key)).toThrow();
    expect(() => limiter.assertAllowed(key + ':different-account')).not.toThrow();
  });
  it('recovers automatically when its bounded window expires', () => {
    vi.useFakeTimers(); const key = randomUUID(); const limiter = createFailureRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.recordFailure(key); expect(() => limiter.assertAllowed(key)).toThrow();
    vi.setSystemTime(Date.now() + 1001); expect(() => limiter.assertAllowed(key)).not.toThrow();
  });
});
