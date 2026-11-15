import { afterEach, describe, expect, it, vi } from 'vitest';
import { weekdayGraceDeadline } from '../../src/services/billing-commercial-clock.service.js';
import { firstSeatRenewalFailure, recordSeatRenewalFailure } from '../../src/services/billing-seat-renewal.service.js';
import { recognizeSeatPaymentPeriod } from '../../src/services/billing-seat-payment-period.service.js';

afterEach(() => vi.useRealTimers());
describe('seat renewal recovery', () => {
  it.each([
    ['2026-11-13T18:30:00Z', 'UTC', '2026-11-16T18:30:00Z'],
    ['2026-11-14T18:30:00Z', 'UTC', '2026-11-17T00:00:00Z'],
    ['2026-10-23T18:30:00Z', 'Europe/London', '2026-10-26T19:30:00Z'],
    ['2026-03-27T18:30:00Z', 'Europe/London', '2026-03-30T17:30:00Z'],
  ])('counts 24 weekday hours from %s in %s', (start, timezone, expected) => {
    expect(weekdayGraceDeadline(new Date(start), timezone).toISOString()).toBe(new Date(expected).toISOString());
  });
  it('continues a bounded history scan and fixes the earliest failure across redelivery', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const at = (value: string) => new Date(value).getTime() / 1000;
    const event = { id: 'latest', created: at('2026-11-15T11:00:00Z'), livemode: false, data: { object: { id: 'in' } } };
    let probe: { earliestFailureAt: Date; cursor: string | null; generation: number; complete: boolean };
    const prisma = { billingSeatRenewalRecovery: { findUnique: vi.fn().mockResolvedValue(null) }, billingSeatFailureHistory: {
      upsert: vi.fn(async ({ create }) => probe ??= { ...create, cursor: null, generation: 0, complete: false }),
      updateMany: vi.fn(async ({ data }) => { probe = { ...probe, ...data, generation: probe.generation + 1 }; }),
      findUniqueOrThrow: vi.fn(async () => probe),
    } };
    const stripe = { events: { list: vi.fn().mockResolvedValueOnce({ has_more: true, data: [event] }).mockResolvedValueOnce({
      has_more: false, data: [{ ...event, id: 'first', created: at('2026-11-13T11:00:00Z') },
        { ...event, id: 'unrelated', created: at('2026-11-12T11:00:00Z'), data: { object: { id: 'other' } } }],
    }) } };
    const invoice = { id: 'in', created: at('2026-11-12T00:00:00Z') };
    await expect(firstSeatRenewalFailure(invoice as never, event as never, 'acct', prisma as never, stripe as never))
      .rejects.toThrow('BILLING_FAILURE_HISTORY_CONTINUING');
    const first = await firstSeatRenewalFailure(invoice as never, event as never, 'acct', prisma as never, stripe as never);
    expect(first.toISOString()).toBe('2026-11-13T11:00:00.000Z');
    expect(stripe.events.list.mock.calls[1][0]).toMatchObject({ starting_after: 'latest' });
    expect(await firstSeatRenewalFailure(invoice as never, event as never, 'acct', prisma as never, stripe as never)).toEqual(first);
    vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));
    expect(await firstSeatRenewalFailure(invoice as never, event as never, 'acct', prisma as never, stripe as never)).toEqual(first);
    expect(stripe.events.list).toHaveBeenCalledTimes(2);
  });
  it('does not reopen debt when a failure arrives after its payment', async () => {
    const tx = { $queryRaw: vi.fn(), billingSeatPaymentPeriod: { findFirst: vi.fn().mockResolvedValue({ id: 'paid' }) },
      billingSeatRenewalRecovery: { upsert: vi.fn() } };
    await recordSeatRenewalFailure(tx as never, { subscriptionId: 'sub', accountId: 'acct', stripeInvoiceId: 'in' } as never);
    expect(tx.billingSeatRenewalRecovery.upsert).not.toHaveBeenCalled();
  });
  it('requires full cash and the exact non-carried seat period to clear renewal debt', async () => {
    const tx = { $queryRaw: vi.fn(), billingSeatPaymentPeriod: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      billingSeatRenewalRecovery: { updateMany: vi.fn() } };
    const receipt = { id: 'receipt', subscriptionId: 'sub', accountId: 'acct', stripeInvoiceId: 'in', paidAt: new Date() };
    const invoice = { status: 'paid', total: 399, amount_due: 399, amount_paid: 399, amount_remaining: 0,
      ending_balance: 0, billing_reason: 'subscription_cycle' };
    const line = { stripeLineId: 'line', subscriptionMinor: 399n,
      seatPeriod: { subscriptionId: 'sub', startsAt: new Date('2026-11-15'), endsAt: new Date('2026-12-15'), quantity: 1 } };
    for (const item of [{ ...line, seatPeriod: undefined },
      { ...line, seatPeriod: { ...line.seatPeriod, subscriptionId: 'different' } }]) {
      await recognizeSeatPaymentPeriod(tx as never, invoice as never, receipt as never, [item] as never);
    }
    await recognizeSeatPaymentPeriod(tx as never, { ...invoice, amount_paid: 0 } as never, receipt as never, [line] as never);
    expect(tx.billingSeatRenewalRecovery.updateMany).not.toHaveBeenCalled();
    await recognizeSeatPaymentPeriod(tx as never, invoice as never, receipt as never,
      [{ ...line, carriedFromStripeInvoiceId: 'previous' }] as never);
    expect(tx.billingSeatPaymentPeriod.create).toHaveBeenCalledOnce();
    expect(tx.billingSeatRenewalRecovery.updateMany).not.toHaveBeenCalled();
    tx.billingSeatPaymentPeriod.create.mockClear();
    await recognizeSeatPaymentPeriod(tx as never, invoice as never, receipt as never, [line] as never);
    expect(tx.billingSeatPaymentPeriod.create).toHaveBeenCalledOnce();
    expect(tx.billingSeatRenewalRecovery.updateMany).toHaveBeenCalledWith({ where: { accountId: 'acct', subscriptionId: 'sub',
      stripeInvoiceId: 'in', recoveredAt: null }, data: { paymentInvoiceId: 'receipt', recoveredAt: receipt.paidAt } });
  });
});
