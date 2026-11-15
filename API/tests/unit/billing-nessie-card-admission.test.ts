import { describe, expect, it, vi } from 'vitest';
import { assertNessieCardOnFile } from '../../src/services/billing-nessie-card-admission.service.js';

const input = { product: 'nessie', organisationId: 'org', teamId: 'team' };
function fixture(cards: unknown[] = []) {
  const prisma = { billingStripeCustomer: { findMany: vi.fn().mockResolvedValue([{ stripeCustomerId: 'cus_org' }]) } };
  const list = vi.fn().mockResolvedValue({ data: cards, has_more: false });
  const collection = { account: { id: 'acct', stripeAccountId: 'acct_provider', livemode: false },
    stripeCollectionEnabled: true, stripe: { paymentMethods: { list } } };
  return { prisma, list, collection, check: () => assertNessieCardOnFile(input, prisma as never, { collection: collection as never }) };
}
const card = { id: 'pm_org', type: 'card', customer: 'cus_org', livemode: false, card: { exp_month: 12, exp_year: 2028 } };
describe('Nessie card-on-file admission', () => {
  it('requires an attached card in the exact financial account and organisation', async () => {
    const f = fixture([card]);
    await expect(f.check()).resolves.toBeUndefined();
    expect(f.prisma.billingStripeCustomer.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { accountId: 'acct', orgId: 'org', teamId: null, stripeCustomerId: { not: null } },
      select: { stripeCustomerId: true }, take: 11,
    });
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ customer: 'cus_org', type: 'card', limit: 1 });
  });
  it('refuses no card without claiming payment or creating a charge', async () => {
    await expect(fixture().check()).rejects.toMatchObject({ statusCode: 402, message: 'NESSIE_BILLING_SETUP_REQUIRED' });
  });
  it('refuses missing customer setup', async () => {
    const f = fixture([card]); f.prisma.billingStripeCustomer.findMany.mockResolvedValue([]);
    await expect(f.check()).rejects.toThrow('NESSIE_BILLING_SETUP_REQUIRED');
    expect(f.list).not.toHaveBeenCalled();
  });
  it.each([{ customer: 'cus_other' }, { livemode: true }, { card: null }, { type: 'sepa_debit' }])(
    'rejects misbound provider evidence: %j', async change => {
      await expect(fixture([{ ...card, ...change }]).check()).rejects.toThrow('BILLING_PAYMENT_METHOD_BINDING_UNPROVEN');
    });
  it('keeps provider unavailability closed', async () => {
    const f = fixture(); f.list.mockRejectedValue(new Error('provider unavailable'));
    await expect(f.check()).rejects.toThrow('provider unavailable');
  });
  it('does not reset or shorten seat-renewal grace for an expired card and prepaid usage', async () => {
    await expect(fixture([{ ...card, card: { exp_month: 1, exp_year: 2020 } }]).check()).resolves.toBeUndefined();
  });
  it('does not change another product', async () => {
    const f = fixture();
    await expect(assertNessieCardOnFile({ ...input, product: 'deepwater' }, f.prisma as never)).resolves.toBeUndefined();
    expect(f.prisma.billingStripeCustomer.findMany).not.toHaveBeenCalled();
  });
});
