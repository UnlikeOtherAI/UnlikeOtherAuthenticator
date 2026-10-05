import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';

const services = vi.hoisted(() => ({
  createBillingTariffVersion: vi.fn(),
}));

vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (
    request: {
      headers: { authorization?: string };
      adminAccessTokenClaims?: { userId: string; email: string };
    },
    reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (request.headers.authorization !== 'Bearer admin-token') {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    request.adminAccessTokenClaims = { userId: 'admin_1', email: 'admin@example.com' };
  },
}));

vi.mock('../../src/services/billing-tariff.service.js', () => ({
  createBillingService: vi.fn(),
  createBillingTariffVersion: services.createBillingTariffVersion,
  removeBillingTariffAssignment: vi.fn(),
  setDefaultBillingTariff: vi.fn(),
  upsertBillingTariffAssignment: vi.fn(),
}));

describe('admin tariff write contract', () => {
  const originalSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  afterEach(() => {
    vi.clearAllMocks();
    if (originalSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSecret;
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('maps exact percent, prepaid, and seat choices into immutable tariff input', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    services.createBillingTariffVersion.mockResolvedValue({
      id: 'tariff_1', serviceId: 'service_1', key: 'standard', version: 1,
      name: 'Standard', mode: 'STANDARD', collectionMode: 'MANUAL',
      markupBps: 3001, monthlyAmountMinor: 2000n, currency: 'GBP',
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'FIXED',
      seatChargeTiming: 'PRORATED', usagePaymentMode: 'PREPAID',
      isDefault: false, createdByEmail: 'admin@example.com',
      createdAt: new Date('2026-10-04T00:00:00.000Z'),
    });
    const app = await createApp();
    try {
      const url = '/internal/admin/billing/services/service_1/tariffs';
      const payload = {
        key: 'standard', name: 'Standard', mode: 'standard',
        collection_mode: 'manual', markup_percent: '30.01',
        usage_payment_mode: 'prepaid',
        monthly_subscription: {
          amount_minor: '2000', currency: 'GBP', charge_basis: 'per_seat',
          seat_policy: 'fixed', seat_charge_timing: 'prorated',
        },
        set_as_default: false,
      };
      const response = await app.inject({
        method: 'POST', url, headers: { authorization: 'Bearer admin-token' }, payload,
      });
      expect(response.statusCode).toBe(201);
      expect(services.createBillingTariffVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: 'service_1',
          tariff: expect.objectContaining({
            markupBps: 3001,
            monthlyAmountMinor: '2000',
            monthlyChargeBasis: 'per_seat',
            seatPolicy: 'fixed',
            seatChargeTiming: 'prorated',
            usagePaymentMode: 'prepaid',
          }),
        }),
      );
      expect(response.json().monthly_subscription.seat_policy).toBe('fixed');
      for (const invalid of [
        { ...payload, markup_bps: 3001 },
        { ...payload, markup_percent: '30.001' },
        { ...payload, markup_percent: 30.01 },
      ]) {
        const rejected = await app.inject({
          method: 'POST', url, headers: { authorization: 'Bearer admin-token' }, payload: invalid,
        });
        expect(rejected.statusCode).toBe(400);
      }
      expect(services.createBillingTariffVersion).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
