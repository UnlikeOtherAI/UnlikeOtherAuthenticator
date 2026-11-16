import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';

const services = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));

vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (
    request: { headers: { authorization?: string }; adminAccessTokenClaims?: Record<string, unknown> },
    reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (request.headers.authorization !== 'Bearer admin-token') return reply.code(401).send({ error: 'UNAUTHORIZED' });
    request.adminAccessTokenClaims = { userId: 'admin_1', email: 'admin@example.com', tokenVersion: 3, domain: 'admin.example.com' };
  },
}));

vi.mock('../../src/services/billing-period-settings.service.js', async (original) => ({
  ...(await original<typeof import('../../src/services/billing-period-settings.service.js')>()),
  getBillingPeriodSettings: services.get,
  saveBillingPeriodSettings: services.save,
}));

describe('admin billing period settings', () => {
  const originalSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const url = '/internal/admin/billing/services/service_1/period-settings';
  const headers = { authorization: 'Bearer admin-token' };
  afterEach(() => {
    vi.clearAllMocks();
    if (originalSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSecret;
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('reads and saves both periods as the signed-in operator, uncached', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const periods = { seat_trial_hours: 168, seat_renewal_grace_hours: 24, updated_at: null };
    services.get.mockResolvedValue(periods);
    services.save.mockResolvedValue({ ...periods, seat_trial_hours: 240, updated_at: '2026-11-16T10:00:00.000Z' });
    const app = await createApp();
    try {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const read = await app.inject({ method: 'GET', url, headers });
      expect(read.statusCode).toBe(200);
      expect(read.headers['cache-control']).toBe('private, no-store');
      expect(read.json()).toEqual(periods);
      const payload = { seat_trial_hours: 240, seat_renewal_grace_hours: 24 };
      const saved = await app.inject({ method: 'PUT', url, headers, payload });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().seat_trial_hours).toBe(240);
      expect(services.save).toHaveBeenCalledWith('service_1', payload,
        { userId: 'admin_1', email: 'admin@example.com', tokenVersion: 3, domain: 'admin.example.com' });
    } finally { await app.close(); }
  });

  it('refuses a missing, fractional, out-of-range or unknown value before any write', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const app = await createApp();
    try {
      for (const payload of [
        { seat_trial_hours: 168 },
        { seat_trial_hours: 0, seat_renewal_grace_hours: 24 },
        { seat_trial_hours: 8761, seat_renewal_grace_hours: 24 },
        { seat_trial_hours: 168, seat_renewal_grace_hours: 721 },
        { seat_trial_hours: 1.5, seat_renewal_grace_hours: 24 },
        { seat_trial_hours: '168', seat_renewal_grace_hours: 24 },
        { seat_trial_hours: 168, seat_renewal_grace_hours: 24, number_grace_hours: 1 },
      ]) {
        expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(400);
      }
      expect(services.save).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
