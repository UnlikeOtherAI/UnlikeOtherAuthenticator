import { describe, expect, it } from 'vitest';
import { BillingTariffFormSchema } from './billing';

const standard = {
  key: 'standard',
  name: 'Standard',
  mode: 'standard',
  collectionMode: 'none',
  markupPercent: '30.00',
  usagePaymentMode: 'prepaid',
  monthlyChargeBasis: 'per_seat',
  seatPolicy: 'automatic',
  seatChargeTiming: 'prorated',
  monthlyAmount: '20.00',
  currency: 'GBP',
  setAsDefault: false,
} as const;

describe('billing tariff operator form', () => {
  it('accepts a prepaid per-seat plan with natural percentage and currency price', () => {
    expect(BillingTariffFormSchema.parse(standard)).toEqual(standard);
  });

  it('requires both seat choices for a per-seat plan', () => {
    expect(BillingTariffFormSchema.safeParse({ ...standard, seatPolicy: undefined }).success)
      .toBe(false);
    expect(BillingTariffFormSchema.safeParse({ ...standard, seatChargeTiming: undefined }).success)
      .toBe(false);
  });

  it('rejects excess money precision and prepaid free terms', () => {
    expect(BillingTariffFormSchema.safeParse({
      ...standard, monthlyAmount: '20.001',
    }).success).toBe(false);
    expect(BillingTariffFormSchema.safeParse({
      ...standard, mode: 'free', markupPercent: '0.00', monthlyAmount: '0.00',
    }).success).toBe(false);
  });
});
