import { expect, it, vi } from 'vitest';
import { listCustomerInvoices, getCustomerInvoiceDetail } from '../../src/services/billing-customer-invoice-read.service.js';
import { db, orgId, ownerId, accountId, context } from './billing-stripe-payment-invoice.suite-fixture.js';
export function registerModeHistoryCase() {
  it('keeps TEST cash out of a LIVE team list while retaining exact historical reads', async () => {
    const team = await db.prisma.team.create({ data: { orgId, name: 'New LIVE team', slug: 'new-live-team' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: ownerId, teamRole: 'owner' } });
    const viewer = { ...context(), request: { ...context().request, teamId: team.id } };
    const original = await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({ where: { orgId, livemode: false } });
    const list = await listCustomerInvoices(viewer, { chargeMonth: '2026-10' }, { prisma: db.prisma });
    expect(list.invoices).toEqual([]);
    const detail = await getCustomerInvoiceDetail(viewer, `stripe:${original.id}`, { prisma: db.prisma });
    expect(detail.invoice_id).toBe(`stripe:${original.id}`);
    expect((await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id: original.id } })).livemode).toBe(false);
  });
  it('does not list cash from a different named account of the same mode', async () => {
    const original = await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({ where: { orgId, livemode: false } });
    vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID', 'acct_anotherNamedTest');
    try {
      expect((await listCustomerInvoices(context(), { chargeMonth: '2026-10' }, { prisma: db.prisma })).invoices).toEqual([]);
      expect((await getCustomerInvoiceDetail(context(), `stripe:${original.id}`, { prisma: db.prisma })).invoice_id)
        .toBe(`stripe:${original.id}`);
    } finally {
      const account = await db.prisma.billingStripeAccount.findUniqueOrThrow({ where: { id: accountId } });
      vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID', account.stripeAccountId);
    }
  });

}
