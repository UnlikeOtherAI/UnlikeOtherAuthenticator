import { describe, expect, it } from 'vitest';
import { serializeBillingTariff } from '../../src/routes/internal/admin/billing-serialization.js';

describe('operator tariff response', () => {
  it('shows human plan choices and exact monthly minor amount', () => {
    const serialized = serializeBillingTariff({
      id: 'tariff_1',
      serviceId: 'service_1',
      key: 'standard',
      version: 2,
      name: 'Standard',
      mode: 'STANDARD',
      collectionMode: 'STRIPE',
      markupBps: 3001,
      monthlyAmountMinor: 2000n,
      monthlyChargeBasis: 'PER_SEAT',
      seatPolicy: 'FIXED',
      seatChargeTiming: 'PRORATED',
      usagePaymentMode: 'PREPAID',
      currency: 'GBP',
      isDefault: false,
      createdByEmail: 'admin@example.com',
      createdAt: new Date('2026-10-04T00:00:00.000Z'),
    });
    expect(serialized.markup_percent).toBe('30.01');
    expect(serialized.usage_payment_mode).toBe('prepaid');
    expect(serialized.monthly_subscription).toEqual({
      amount_minor: '2000',
      currency: 'GBP',
      charge_basis: 'per_seat',
      seat_policy: 'fixed',
      seat_charge_timing: 'prorated',
    });
  });
});
