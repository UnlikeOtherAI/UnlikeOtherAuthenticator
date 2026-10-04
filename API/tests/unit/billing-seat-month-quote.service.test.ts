import { BillingSeatChargeTiming, BillingSeatPolicy } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { quoteMonthlySeatCharge } from '../../src/services/billing-seat-month-quote.service.js';

const at = (value: string) => new Date(value);
const month = '2028-02'; // Leap month: 29 actual UTC days.

describe('monthly seat quote', () => {
  it('deduplicates one organisation subject and sums leave/rejoin intervals before rounding', () => {
    const quote = quoteMonthlySeatCharge({ billingMonth: month,
      seatPolicy: BillingSeatPolicy.AUTOMATIC,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      unitAmountMinor: 100n, activatedAt: at('2028-02-01T00:00:00Z'), endedAt: null,
      membershipIntervals: [
        { id: 'same-subject-team-a', userId: 'person-1',
          startsAt: at('2028-02-01T00:00:00Z'), endsAt: at('2028-02-08T00:00:00Z') },
        { id: 'same-subject-team-b', userId: 'person-1',
          startsAt: at('2028-02-22T00:00:00Z'), endsAt: at('2028-03-01T00:00:00Z') },
      ], capacityRevisions: [] });
    expect(quote.uniqueHumanSeats).toBe(1);
    expect(quote.seatMilliseconds).toBe(15n * 86_400_000n);
    expect(quote.monthMilliseconds).toBe(29n * 86_400_000n);
    expect(quote.amountMinor).toBe(52n);
  });

  it('counts each active human once for full-month automatic, including short overlaps', () => {
    const quote = quoteMonthlySeatCharge({ billingMonth: month,
      seatPolicy: BillingSeatPolicy.AUTOMATIC,
      seatChargeTiming: BillingSeatChargeTiming.FULL_MONTH,
      unitAmountMinor: 299n, activatedAt: at('2028-02-01T00:00:00Z'), endedAt: null,
      membershipIntervals: [
        { id: 'one', userId: 'person-1',
          startsAt: at('2028-02-01T00:00:00Z'), endsAt: at('2028-02-01T00:00:00.001Z') },
        { id: 'two', userId: 'person-2',
          startsAt: at('2028-02-01T00:00:00Z'), endsAt: at('2028-02-02T00:00:00Z') },
      ], capacityRevisions: [] });
    expect(quote.amountMinor).toBe(598n);
    expect(quote.uniqueHumanSeats).toBe(2);
  });

  it('prorates fixed purchased capacity and charges full-month increases this month', () => {
    const base = { billingMonth: month,
      seatPolicy: BillingSeatPolicy.FIXED, unitAmountMinor: 100n,
      activatedAt: at('2028-02-01T00:00:00Z'), endedAt: null,
      membershipIntervals: [], capacityRevisions: [
        { id: 'initial', quantity: 2, effectiveAt: at('2028-02-01T00:00:00Z') },
        { id: 'increase', quantity: 4, effectiveAt: at('2028-02-15T00:00:00Z') },
        { id: 'decrease', quantity: 1, effectiveAt: at('2028-02-25T00:00:00Z') },
      ] } as const;
    const prorated = quoteMonthlySeatCharge({ ...base,
      capacityRevisions: [...base.capacityRevisions],
      seatChargeTiming: BillingSeatChargeTiming.PRORATED });
    expect(prorated.seatMilliseconds).toBe((2n * 14n + 4n * 10n + 1n * 5n) * 86_400_000n);
    expect(prorated.amountMinor).toBe(252n);
    const full = quoteMonthlySeatCharge({ ...base,
      capacityRevisions: [...base.capacityRevisions],
      seatChargeTiming: BillingSeatChargeTiming.FULL_MONTH });
    expect(full.amountMinor).toBe(400n);
    const next = quoteMonthlySeatCharge({ ...base, billingMonth: '2028-03',
      capacityRevisions: [...base.capacityRevisions],
      seatChargeTiming: BillingSeatChargeTiming.FULL_MONTH });
    expect(next.amountMinor).toBe(100n);
  });

  it('holds overlapping subject intervals and missing fixed activation evidence', () => {
    const common = { billingMonth: month, unitAmountMinor: 100n,
      activatedAt: at('2028-02-01T00:00:00Z'), endedAt: null };
    expect(() => quoteMonthlySeatCharge({ ...common,
      seatPolicy: BillingSeatPolicy.AUTOMATIC,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      capacityRevisions: [], membershipIntervals: [
        { id: 'a', userId: 'person-1', startsAt: at('2028-02-01T00:00:00Z'), endsAt: null },
        { id: 'b', userId: 'person-1', startsAt: at('2028-02-02T00:00:00Z'), endsAt: null },
      ] })).toThrow('BILLING_SEAT_EVIDENCE_INVALID');
    expect(() => quoteMonthlySeatCharge({ ...common,
      seatPolicy: BillingSeatPolicy.FIXED,
      seatChargeTiming: BillingSeatChargeTiming.FULL_MONTH,
      membershipIntervals: [], capacityRevisions: [],
    })).toThrow('BILLING_SEAT_EVIDENCE_INVALID');
  });

  it('tracks a future contract roster before its commercial boundary without charging early', () => {
    const agreement = { seatPolicy: BillingSeatPolicy.AUTOMATIC,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      unitAmountMinor: 290n, activatedAt: at('2028-01-25T12:00:00Z'),
      commercialEffectiveAt: at('2028-02-01T00:00:00Z'),
      commercialEndsAt: at('2028-03-01T00:00:00Z'), endedAt: null,
      capacityRevisions: [], membershipIntervals: [
        { id: 'observed-roster', userId: 'person-1',
          startsAt: at('2028-01-25T12:00:00Z'), endsAt: at('2028-02-15T00:00:00Z') },
      ] };
    expect(quoteMonthlySeatCharge({ ...agreement, billingMonth: '2028-01' }).amountMinor).toBe(0n);
    expect(quoteMonthlySeatCharge({ ...agreement, billingMonth: month }).amountMinor).toBe(140n);
    expect(quoteMonthlySeatCharge({ ...agreement, billingMonth: '2028-03' }).amountMinor).toBe(0n);
  });
});
