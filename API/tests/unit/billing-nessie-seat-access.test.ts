import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readNessieSeatAccess } from '../../src/services/billing-nessie-seat-access.service.js';

const mocks = vi.hoisted(() => ({ tariff: vi.fn(), mode: vi.fn(), transition: vi.fn() }));
vi.mock('../../src/services/billing-current-tariff.service.js', () => ({ resolveCurrentBillingTariff: mocks.tariff }));
vi.mock('../../src/services/billing-team-mode.service.js', () => ({ resolveTeamBillingMode: mocks.mode }));
vi.mock('../../src/services/billing-nessie-seat-transition.service.js', () => ({ nessieSeatTransition: mocks.transition }));
vi.mock('../../src/config/env.js', () => ({ getEnv: () => ({ STRIPE_LIVE_ACCOUNT_ID: 'acct_live', STRIPE_SANDBOX_ACCOUNT_ID: 'acct_test' }) }));
const now = new Date('2026-11-15T12:00:00Z');
const scope = { serviceId: 'nessie', organisationId: 'org', teamId: 'team', userId: 'original' };
const paid = { tariffId: 'regular', initialSeatInvoiceId: 'initial', status: 'active', paidSeatPeriods: [{ id: 'period' }], seatRenewals: [] };
function db(rows: Array<Record<string, unknown>> = [], history = rows.length) {
  return { $queryRaw: vi.fn().mockResolvedValue([{ paid: rows.some(row => row.status === 'active' &&
    Array.isArray(row.paidSeatPeriods) && row.paidSeatPeriods.length > 0) }]), billingStripeSubscription: { findMany: vi.fn().mockResolvedValue(rows), count: vi.fn().mockResolvedValue(history) } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tariff.mockResolvedValue({ source: 'SERVICE_DEFAULT', tariff: { id: 'regular', anniversarySeats: true } });
  mocks.mode.mockResolvedValue({ mode: 'live' });
  mocks.transition.mockResolvedValue({ endedAt: null, endsAt: new Date('2026-11-29T12:00:00Z'), cohortUserIds: ['original'] });
});
describe('Nessie seat access', () => {
  it('selects only the current organisation account and a collected current period', async () => {
    const tx = db([paid]);
    expect(await readNessieSeatAccess(tx as never, scope, now)).toMatchObject({ allowed: true, status: 'paid' });
    expect(tx.billingStripeSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      serviceId: 'nessie', orgId: 'org', teamId: null, account: { stripeAccountId: 'acct_live', livemode: true },
    } }));
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });
  it.each([{ initialSeatInvoiceId: null }, { paidSeatPeriods: [] }, { status: 'past_due' }, { tariffId: 'different' }])(
    'does not mistake an active subscription or old receipt for payment: %j', async change => {
      expect(await readNessieSeatAccess(db([{ ...paid, ...change }]) as never, scope, now)).toMatchObject({ allowed: false });
      expect(mocks.transition).not.toHaveBeenCalled();
    });
  it('allows only the frozen cohort and only before the original deadline', async () => {
    expect(await readNessieSeatAccess(db() as never, scope, now)).toMatchObject({ allowed: true, status: 'transition' });
    expect(await readNessieSeatAccess(db() as never, { ...scope, userId: 'new' }, now)).toMatchObject({ allowed: false });
    expect(await readNessieSeatAccess(db() as never, scope, new Date('2026-11-29T12:00:00Z'))).toMatchObject({ allowed: false });
    mocks.transition.mockResolvedValue({ endedAt: now, endsAt: new Date('2026-11-29T12:00:00Z'), cohortUserIds: ['original'] });
    expect(await readNessieSeatAccess(db() as never, scope, now)).toMatchObject({ allowed: false });
  });
  it('holds missing product enrollment instead of inventing a free-seat cohort', async () => {
    mocks.transition.mockResolvedValue(null);
    expect(await readNessieSeatAccess(db() as never, scope, now))
      .toMatchObject({ allowed: false, reason: 'setup_required' });
  });
  it('does not grant another allowance after cancellation or a billing-mode change', async () => {
    expect(await readNessieSeatAccess(db([{ ...paid, status: 'canceled' }]) as never, scope, now)).toMatchObject({ allowed: false });
    expect(await readNessieSeatAccess(db([], 1) as never, scope, now)).toMatchObject({ allowed: false });
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('honours the saved renewal deadline, and blocks at its exact boundary', async () => {
    const row = { ...paid, status: 'past_due', paidSeatPeriods: [], seatRenewals: [{ graceEndsAt: now, reason: 'payment_required' }] };
    expect(await readNessieSeatAccess(db([row]) as never, scope, new Date(now.getTime() - 1)))
      .toMatchObject({ allowed: true, status: 'renewal_grace', deadline: now.toISOString() });
    expect(await readNessieSeatAccess(db([row]) as never, scope, now)).toMatchObject({ allowed: false, deadline: now.toISOString() });
  });
  it('preserves an explicit seat agreement but cannot turn an invalid default into one', async () => {
    for (const source of ['ORGANISATION', 'TEAM', 'SERVICE_DEFAULT']) {
      mocks.tariff.mockResolvedValue({ source, tariff: { anniversarySeats: false } });
      expect((await readNessieSeatAccess(db() as never, scope, now)).allowed).toBe(source !== 'SERVICE_DEFAULT');
    }
  });
  it('holds ambiguous subscriptions instead of choosing whichever looks paid', async () => {
    await expect(readNessieSeatAccess(db([paid, paid]) as never, scope, now)).rejects.toThrow('BILLING_SEAT_SUBSCRIPTION_AMBIGUOUS');
  });
});
