import { describe, expect, it, vi } from 'vitest';

import { reconcileStripeCycleInvoiceUsage } from '../../src/services/billing-stripe-invoice.service.js';

const account = {
  id: 'stripe_account_row',
  stripeAccountId: 'acct_uoa',
  livemode: false,
};

function cycleInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_renewal',
    object: 'invoice',
    livemode: false,
    billing_reason: 'subscription_cycle',
    created: 1_785_542_400,
    automatically_finalizes_at: 1_785_546_000,
    status: 'draft',
    collection_method: 'charge_automatically',
    auto_advance: true,
    currency: 'usd',
    customer: 'cus_1',
    period_start: 1_782_864_000,
    period_end: 1_785_542_400,
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: {
        subscription: 'sub_1',
        metadata: {},
      },
    },
    automatic_tax: { status: null },
    last_finalization_error: null,
    ...overrides,
  };
}

function setup(invoice = cycleInvoice()) {
  const subscription = {
    id: 'subscription_1',
    accountId: account.id,
    livemode: false,
    currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    customer: { stripeCustomerId: 'cus_1' },
    tariff: { currency: 'USD' },
  };
  const prisma = {
    billingStripeSubscription: {
      findUnique: vi.fn().mockResolvedValue(subscription),
    },
  };
  const stripe = {
    accounts: {},
    billing: {},
    invoices: { retrieve: vi.fn().mockResolvedValue(invoice) },
  };
  const exportUsage = vi.fn().mockResolvedValue({
    ledgerSnapshotCursor: 'bus_post_period',
    billingMonth: '2026-07',
    exports: [],
  });
  return { prisma, stripe, exportUsage, subscription };
}

describe('Stripe invoice grace-period reconciliation', () => {
  it('exports the exact just-ended calendar month after the subscription advances', async () => {
    const state = setup();
    const now = new Date('2026-08-01T00:00:10.000Z');

    await expect(
      reconcileStripeCycleInvoiceUsage(
        {
          invoiceId: 'in_renewal',
          eventType: 'invoice.created',
          account,
        },
        {
          prisma: state.prisma as never,
          stripe: state.stripe as never,
          exportUsage: state.exportUsage,
          now: () => now,
        },
      ),
    ).resolves.toMatchObject({
      ledgerSnapshotCursor: 'bus_post_period',
      billingMonth: '2026-07',
    });

    expect(state.exportUsage).toHaveBeenCalledWith(
      {
        subscriptionId: 'subscription_1',
        billingMonth: '2026-07',
      },
      expect.objectContaining({
        prisma: state.prisma,
        stripe: state.stripe,
        stripeLivemode: false,
        invoicePeriod: {
          startsAt: new Date('2026-07-01T00:00:00.000Z'),
          endsAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      }),
    );
  });

  it('rejects an invoice that does not bind to the projected customer', async () => {
    const state = setup(cycleInvoice({ customer: 'cus_other' }));

    await expect(
      reconcileStripeCycleInvoiceUsage(
        {
          invoiceId: 'in_renewal',
          eventType: 'invoice.created',
          account,
        },
        {
          prisma: state.prisma as never,
          stripe: state.stripe as never,
          exportUsage: state.exportUsage,
        },
      ),
    ).rejects.toThrow('STRIPE_INVOICE_BINDING_INVALID');
    expect(state.exportUsage).not.toHaveBeenCalled();
  });

  it('fails closed when a cycle invoice has less than one hour of draft grace', async () => {
    const state = setup(cycleInvoice({ automatically_finalizes_at: 1_785_545_999 }));

    await expect(
      reconcileStripeCycleInvoiceUsage(
        {
          invoiceId: 'in_renewal',
          eventType: 'invoice.created',
          account,
        },
        {
          prisma: state.prisma as never,
          stripe: state.stripe as never,
          exportUsage: state.exportUsage,
        },
      ),
    ).rejects.toThrow('STRIPE_INVOICE_GRACE_PERIOD_INSUFFICIENT');
    expect(state.prisma.billingStripeSubscription.findUnique).not.toHaveBeenCalled();
    expect(state.exportUsage).not.toHaveBeenCalled();
  });

  it('logs a finalization failure without trying to mutate a non-draft invoice', async () => {
    const state = setup(
      cycleInvoice({
        status: 'open',
        automatic_tax: { status: 'requires_location_inputs' },
        last_finalization_error: {
          code: 'customer_tax_location_invalid',
          type: 'invalid_request_error',
        },
      }),
    );
    const log = { error: vi.fn() };

    await expect(
      reconcileStripeCycleInvoiceUsage(
        {
          invoiceId: 'in_renewal',
          eventType: 'invoice.finalization_failed',
          account,
        },
        {
          prisma: state.prisma as never,
          stripe: state.stripe as never,
          exportUsage: state.exportUsage,
          log,
        },
      ),
    ).resolves.toBeNull();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeInvoiceId: 'in_renewal',
        automaticTaxStatus: 'requires_location_inputs',
        finalizationErrorCode: 'customer_tax_location_invalid',
      }),
      'Stripe invoice finalization failed',
    );
    expect(state.exportUsage).not.toHaveBeenCalled();
  });
});
