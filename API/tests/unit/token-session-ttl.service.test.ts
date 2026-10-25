import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfigFields } from '../../src/services/config.service.js';
import { resolveRefreshTokenLifetime } from '../../src/services/token-session-ttl.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

afterEach(() => vi.unstubAllEnvs());

describe('admin refresh family lifetime', () => {
  it.each([0, 1, 999])('uses the access deadline at millisecond offset %i', (milliseconds) => {
    vi.stubEnv('ADMIN_AUTH_DOMAIN', 'admin.example.com');
    const config = validateConfigFields(baseClientConfigPayload({ domain: 'admin.example.com' }));
    const now = new Date(Date.UTC(2026, 9, 25, 12, 0, 0, milliseconds));
    const lifetime = resolveRefreshTokenLifetime(config, '15m', 30 * 86400, now);
    expect(lifetime.ttlSeconds).toBe(900);
    expect(lifetime.expiresAt).toEqual(new Date('2026-10-25T12:15:00.000Z'));
    expect(lifetime.expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(900_000);
  });

  it('keeps an inherited admin family inside its shorter source deadline', () => {
    vi.stubEnv('ADMIN_AUTH_DOMAIN', 'admin.example.com');
    const config = validateConfigFields(baseClientConfigPayload({ domain: 'admin.example.com' }));
    const now = new Date('2026-10-25T12:00:00.999Z');
    const sourceDeadline = new Date('2026-10-25T12:00:05.000Z');
    const remaining = Math.floor((sourceDeadline.getTime() - now.getTime()) / 1000);
    const lifetime = resolveRefreshTokenLifetime(config, '15m', remaining, now);
    expect(lifetime.expiresAt.getTime()).toBeLessThanOrEqual(sourceDeadline.getTime());
    expect(lifetime.expiresAt.getTime() % 1000).toBe(0);
    expect(lifetime.expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('preserves ordinary product refresh lifetimes and timestamp precision', () => {
    vi.stubEnv('ADMIN_AUTH_DOMAIN', 'admin.example.com');
    const config = validateConfigFields(baseClientConfigPayload({ domain: 'product.example.com' }));
    const now = new Date('2026-10-25T12:00:00.999Z');
    const lifetime = resolveRefreshTokenLifetime(config, '15m', 30 * 86400, now);
    expect(lifetime.now).toBe(now);
    expect(lifetime.ttlSeconds).toBe(30 * 86400);
    expect(lifetime.expiresAt.getTime() - now.getTime()).toBe(30 * 86400_000);
  });
});
