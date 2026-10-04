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
    stripeUsageItemId: 'si_usage_1',
    stripeMonthlyItemId: null,
    status: 'active',
    cancelAtPeriodEnd: false,
    customer: { stripeCustomerId: 'cus_1' },
    tariff: { currency: 'USD' },
  };
  const prisma = {
    billingStripeSubscription: {
      findUnique: vi.fn().mockResolvedValue(subscription),
    },
    billingStripeInvoiceClose: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation(async ({ create, update }: { create: object; update: object }) => ({
        ...create, ...update,
      })),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
  };
  const stripe = {
    accounts: {},
    billing: {},
    invoices: {
      retrieve: vi.fn().mockResolvedValue(invoice),
      listLineItems: vi.fn().mockResolvedValue({ data: [{
        id: 'il_usage_1', invoice: 'in_renewal', livemode: false, currency: 'usd',
        period: { start: 1_782_864_000, end: 1_785_542_400 },
        parent: { type: 'subscription_item_details', subscription_item_details: {
          subscription: 'sub_1', subscription_item: 'si_usage_1', proration: false,
        } },
      }], has_more: false }),
      update: vi.fn().mockImplementation(async (_id: string, data: { auto_advance: boolean }) => ({
        ...invoice, auto_advance: data.auto_advance,
      })),
    },
  };
  const exportUsage = vi.fn().mockResolvedValue({
    ledgerSnapshotCursor: 'bus_post_period',
    billingMonth: '2026-07',
    exports: [],
  });
  const collectMonthlyCharge = vi.fn().mockResolvedValue(undefined);
  return { prisma, stripe, exportUsage, collectMonthlyCharge, subscription };
}

describe('Stripe invoice grace-period reconciliation', () => {
  it('durably holds a draft invoice and pauses finalization when Ledger coverage is unresolved', async () => {
    const state = setup();
    state.exportUsage.mockRejectedValue(new Error('LEDGER_METERING_UNRESOLVED_PAID_USAGE'));
    await expect(reconcileStripeCycleInvoiceUsage({
      invoiceId: 'in_renewal', eventType: 'invoice.created', account,
    }, {
      prisma: state.prisma as never, stripe: state.stripe as never,
      exportUsage: state.exportUsage, collectMonthlyCharge: state.collectMonthlyCharge,
      manageClose: true,
      now: () => new Date('2026-08-01T00:00:10.000Z'),
    })).resolves.toBeNull();
    expect(state.stripe.invoices.update).toHaveBeenCalledWith('in_renewal', {
      auto_advance: false,
    });
    expect(state.prisma.billingStripeInvoiceClose.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ state: 'HELD' }) }),
    );
  });

  it('marks an already finalized period for exact liability assessment', async () => {
    const state = setup(cycleInvoice({ status: 'open', auto_advance: false }));
    await expect(reconcileStripeCycleInvoiceUsage({
      invoiceId: 'in_renewal', eventType: 'invoice.finalized', account,
    }, {
      prisma: state.prisma as never, stripe: state.stripe as never,
      exportUsage: state.exportUsage, collectMonthlyCharge: state.collectMonthlyCharge,
      manageClose: true,
    })).resolves.toBeNull();
    expect(state.exportUsage).not.toHaveBeenCalled();
    expect(state.prisma.billingStripeInvoiceClose.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ state: 'FINALIZED_HOLD' }) }),
    );
  });

  it('exports the exact just-ended calendar month after the subscription advances', async () => {
    // Stripe's invoice header can span creation/finalization and is not the
    // service line's billed month.
    const state = setup(cycleInvoice({ period_start: 1_785_542_400,
      period_end: 1_788_220_800 }));
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
          collectMonthlyCharge: state.collectMonthlyCharge,
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
    expect(state.collectMonthlyCharge).toHaveBeenCalledWith(
      expect.objectContaining({ billingMonth: '2026-07',
        periodStartsAt: new Date('2026-07-01T00:00:00.000Z') }),
      expect.objectContaining({ stripe: state.stripe }),
    );
  });

  it('holds a renewal without a verified subscription line period', async () => {
    const state = setup();
    state.stripe.invoices.listLineItems.mockResolvedValue({ data: [], has_more: false });
    await expect(reconcileStripeCycleInvoiceUsage({
      invoiceId: 'in_renewal', eventType: 'invoice.created', account,
    }, { prisma: state.prisma as never, stripe: state.stripe as never,
      exportUsage: state.exportUsage, collectMonthlyCharge: state.collectMonthlyCharge,
    })).rejects.toThrow('STRIPE_INVOICE_SERVICE_PERIOD_UNPROVEN');
    expect(state.exportUsage).not.toHaveBeenCalled();
    expect(state.collectMonthlyCharge).not.toHaveBeenCalled();
  });

  it('uses the completed usage month while a flat price charges the next month in advance', async () => {
    const state = setup();
    state.subscription.stripeMonthlyItemId = 'si_monthly';
    const usage = {
      id: 'il_usage_1', invoice: 'in_renewal', livemode: false, currency: 'usd',
      period: { start: 1_782_864_000, end: 1_785_542_400 },
      parent: { type: 'subscription_item_details', subscription_item_details: {
        subscription: 'sub_1', subscription_item: 'si_usage_1', proration: false,
      } },
    };
    const monthly = { ...usage, id: 'il_monthly',
      period: { start: 1_785_542_400, end: 1_788_220_800 },
      parent: { type: 'subscription_item_details', subscription_item_details: {
        subscription: 'sub_1', subscription_item: 'si_monthly', proration: false,
      } },
    };
    state.stripe.invoices.listLineItems.mockResolvedValue({
      data: [usage, monthly], has_more: false,
    });
    await reconcileStripeCycleInvoiceUsage({
      invoiceId: 'in_renewal', eventType: 'invoice.created', account,
    }, { prisma: state.prisma as never, stripe: state.stripe as never,
      exportUsage: state.exportUsage, collectMonthlyCharge: state.collectMonthlyCharge,
    });
    expect(state.exportUsage).toHaveBeenCalledWith(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      expect.anything(),
    );
    state.stripe.invoices.listLineItems.mockResolvedValue({ data: [monthly], has_more: false });
    await reconcileStripeCycleInvoiceUsage({
      invoiceId: 'in_renewal', eventType: 'invoice.created', account,
    }, { prisma: state.prisma as never, stripe: state.stripe as never,
      exportUsage: state.exportUsage, collectMonthlyCharge: state.collectMonthlyCharge,
    });
    expect(state.exportUsage).toHaveBeenLastCalledWith(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      expect.anything(),
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
          collectMonthlyCharge: state.collectMonthlyCharge,
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
          collectMonthlyCharge: state.collectMonthlyCharge,
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
          collectMonthlyCharge: state.collectMonthlyCharge,
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
