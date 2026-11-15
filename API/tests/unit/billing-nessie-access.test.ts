import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nessieBillingAccess } from '../../src/services/billing-nessie-access.service.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), seats: vi.fn(), reserved: vi.fn() }));
vi.mock('../../src/services/billing-organisation-authority.service.js', () => ({ authorizeOrganisationBilling: mocks.authorize }));
vi.mock('../../src/services/billing-nessie-seat-access.service.js', () => ({ readNessieSeatAccess: mocks.seats }));
vi.mock('../../src/services/billing-credit-holds.service.js', () => ({ billingReservedMicrocredits: mocks.reserved }));
vi.mock('../../src/services/billing-organisation-mode.service.js', () => ({ resolveOrganisationBillingMode: async () => ({ mode: 'live' }) }));
vi.mock('../../src/services/billing-organisation-financial-account.service.js', () => ({ organisationFinancialAccount: async () => ({ id: 'account' }) }));
vi.mock('../../src/services/billing-current-tariff.service.js', () => ({ resolveCurrentBillingTariff: async () => ({ source: 'SERVICE_DEFAULT', tariff: { mode: 'STANDARD' } }) }));
const context = { request: { product: 'nessie', organisationId: 'org', teamId: 'team', userId: 'user' }, credential: { service: { id: 'service' } } };
const wallet = { id: 'wallet', orgId: 'org', teamId: null, scope: 'ORGANISATION', balanceMicrocredits: 100n };
function db(value: unknown = wallet) {
  const tx = { billingCreditAccount: { findUnique: vi.fn().mockResolvedValue(value) } };
  return { $transaction: (work: (tx: unknown) => Promise<unknown>) => work(tx) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ billingManager: false, teamRole: 'admin' });
  mocks.seats.mockResolvedValue({ allowed: true, status: 'renewal_grace', deadline: '2026-11-17T12:00:00Z', reason: 'card_expired' });
  mocks.reserved.mockResolvedValue(100n);
});
describe('member-safe billing admission', () => {
  it('shows no payment diagnosis, card or amounts to a member or team administrator', async () => {
    const value = await nessieBillingAccess(context as never, { prisma: db() as never });
    expect(value.can_manage_billing).toBe(false);
    expect(value).not.toHaveProperty('manager_reason');
    expect(JSON.stringify(value)).not.toMatch(/expired|balance|amount|wallet|card/);
    expect(value.consumables.available).toBe(false);
  });
  it('lets the organisation billing manager see the actionable reason', async () => {
    mocks.authorize.mockResolvedValue({ billingManager: true });
    expect(await nessieBillingAccess(context as never, { prisma: db() as never }))
      .toMatchObject({ can_manage_billing: true, manager_reason: 'card_expired' });
  });
  it('removes financial details if the manager is demoted during the read', async () => {
    mocks.authorize.mockResolvedValueOnce({ billingManager: true }).mockResolvedValueOnce({ billingManager: false });
    expect(await nessieBillingAccess(context as never, { prisma: db() as never })).not.toHaveProperty('manager_reason');
  });
  it('uses spendable credits after holds, with no missing-wallet allowance', async () => {
    mocks.reserved.mockResolvedValue(99n);
    expect((await nessieBillingAccess(context as never, { prisma: db() as never })).consumables.available).toBe(true);
    expect((await nessieBillingAccess(context as never, { prisma: db(null) as never })).consumables.available).toBe(false);
    mocks.seats.mockResolvedValue({ allowed: false, status: 'payment_required', deadline: null, reason: 'payment_required' });
    expect((await nessieBillingAccess(context as never, { prisma: db() as never })).consumables.available).toBe(false);
  });
});
