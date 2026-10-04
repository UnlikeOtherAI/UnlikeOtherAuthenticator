import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { collectStripeCorrectionInvoice } from '../../src/services/billing-stripe-correction-invoice.service.js';
import { compensateFinalizedStripeInvoice } from '../../src/services/billing-stripe-invoice-close-resolution.service.js';
import { invoicedStripeUsageAmountMinor } from '../../src/services/billing-stripe-invoice-close-scheduler.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { correctionFixture } from '../helpers/stripe-correction-fixture.js';

describe.skipIf(!process.env.DATABASE_URL)('durable Stripe usage corrections', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let fixture: Awaited<ReturnType<typeof correctionFixture>>;
  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL_REQUIRED');
    db = handle;
    fixture = await correctionFixture(db.prisma);
  });
  afterAll(async () => { await db?.cleanup(); });
  const params = () => ({ closeId: fixture.close.id,
    amountMicroMinor: 130_000_000n, cursor: 'bus_correction_1' });
  const deps = () => ({ prisma: db.prisma, stripe: fixture.stripe });

  it('recovers lost invoice and item acknowledgements, charges only delta plus verified tax, and binds actual cash once', async () => {
    fixture.loseInvoiceAck();
    await expect(collectStripeCorrectionInvoice(params(), deps())).rejects.toThrow('lost invoice acknowledgement');
    expect(fixture.client.invoices.create).toHaveBeenCalledTimes(1);
    fixture.loseItemAck();
    await expect(collectStripeCorrectionInvoice(params(), deps())).rejects.toThrow('lost item acknowledgement');
    expect(fixture.client.invoices.create).toHaveBeenCalledTimes(1);
    expect(fixture.client.invoiceItems.create).toHaveBeenCalledTimes(1);
    const collected = await collectStripeCorrectionInvoice(params(), deps());
    expect(fixture.client.invoices.create).toHaveBeenCalledTimes(1);
    expect(fixture.client.invoiceItems.create).toHaveBeenCalledTimes(1);
    expect(fixture.client.invoices.finalizeInvoice).toHaveBeenCalledWith('in_supp_1', { auto_advance: false });
    expect(fixture.client.invoiceItems.create.mock.calls[0]?.[0]).toMatchObject({
      amount: 130, tax_rates: ['txr_20'], tax_behavior: 'exclusive', discountable: false });
    expect(fixture.invoices[collected.stripeInvoiceId]).toMatchObject({ status: 'open',
      total: 156, amount_due: 156, auto_advance: true });
    expect(await db.prisma.billingStripePaymentInvoice.count()).toBe(0);
    const before = await db.prisma.billingStripeCycleCorrection.findUniqueOrThrow({
      where: { id: collected.correctionId } });
    expect(before).toMatchObject({ amountMinor: 130n, paidAt: null });
    await expect(db.prisma.billingStripeCycleCorrection.update({ where: { id: before.id },
      data: { amountMinor: 131n } })).rejects.toThrow('STRIPE_CYCLE_CORRECTION_IMMUTABLE');
    await expect(db.prisma.billingStripeCycleCorrection.delete({ where: { id: before.id } }))
      .rejects.toThrow('STRIPE_CYCLE_CORRECTION_IMMUTABLE');
    fixture.pay(collected.stripeInvoiceId);
    await collectStripeCorrectionInvoice(params(), deps());
    const paid = await db.prisma.billingStripeCycleCorrection.findUniqueOrThrow({ where: { id: before.id } });
    expect(paid.paidAt).not.toBeNull();
    const source = await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({
      include: { lines: true, cashPayments: true } });
    expect(source).toMatchObject({ grossAmountMinor: 156n, taxAmountMinor: 26n,
      dueAmountMinor: 156n, paidAmountMinor: 156n, state: 'PENDING' });
    expect(source.lines[0]).toMatchObject({ subscriptionMinor: 0n, usageMinor: 130n,
      taxMinor: 26n, billingMonth: '2026-08' });
    expect(source.cashPayments[0]?.amountMinor).toBe(156n);
    await compensateFinalizedStripeInvoice({ closeId: fixture.close.id,
      adjustmentInvoiceId: collected.stripeInvoiceId, correctionId: paid.id,
      actorEmail: 'billing-cycle-scheduler', observedAt: new Date() }, deps());
    expect(await db.prisma.billingStripeInvoiceCloseResolution.count()).toBe(1);
    expect(await db.prisma.billingStripePaymentInvoice.count()).toBe(1);
    expect(fixture.original.total).toBe(1200);
  });

  it('creates a later supplement for only the remaining earned difference, without another subscription fee', async () => {
    await db.prisma.billingStripeInvoiceClose.update({ where: { id: fixture.close.id }, data: {
      state: 'FINALIZED_HOLD', ledgerSnapshotCursor: 'bus_correction_2',
      unbilledAmountMicroMinor: 70_000_000n } });
    const later = { closeId: fixture.close.id, amountMicroMinor: 70_000_000n, cursor: 'bus_correction_2' };
    const result = await collectStripeCorrectionInvoice(later, deps());
    expect(fixture.invoices[result.stripeInvoiceId]).toMatchObject({ total: 84, amount_due: 84 });
    fixture.pay(result.stripeInvoiceId);
    await collectStripeCorrectionInvoice(later, deps());
    const rows = await db.prisma.billingStripeInvoiceCloseResolution.findMany();
    expect(rows.reduce((sum, row) => sum + row.paidAmountMinor, 0n)).toBe(200n);
    expect(await db.prisma.billingStripePaymentInvoice.count()).toBe(2);
    expect((await db.prisma.billingStripePaymentInvoiceLine.findMany()).every((row) =>
      row.subscriptionMinor === 0n)).toBe(true);
    expect(fixture.client.invoices.create).toHaveBeenCalledTimes(2);
  });

  it('holds tax changes, stale liability, unknown lines and expired uncertain creation before charging', async () => {
    const fresh = { closeId: fixture.close.id, amountMicroMinor: 10_000_000n, cursor: 'bus_correction_3' };
    await db.prisma.billingStripeInvoiceClose.update({ where: { id: fixture.close.id }, data: {
      state: 'FINALIZED_HOLD', ledgerSnapshotCursor: fresh.cursor,
      unbilledAmountMicroMinor: fresh.amountMicroMinor } });
    fixture.rate.active = false;
    await expect(collectStripeCorrectionInvoice(fresh, deps())).rejects.toThrow('STRIPE_CORRECTION_TAX_RATE_UNPROVEN');
    fixture.rate.active = true;
    await expect(collectStripeCorrectionInvoice({ ...fresh, cursor: 'bus_stale' }, deps()))
      .rejects.toThrow('STRIPE_CORRECTION_LIABILITY_CHANGED');
    fixture.loseInvoiceAck();
    await expect(collectStripeCorrectionInvoice(fresh, deps())).rejects.toThrow('lost invoice acknowledgement');
    const pending = await db.prisma.billingStripeCycleCorrection.findFirstOrThrow({
      where: { closeId: fixture.close.id, paidAt: null } });
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`UPDATE billing_stripe_cycle_corrections
        SET first_attempt_at = now() - interval '25 hours' WHERE id = ${pending.id}::uuid`);
    });
    fixture.client.invoices.list.mockResolvedValueOnce({ data: [], has_more: false });
    await expect(collectStripeCorrectionInvoice(fresh, deps())).rejects.toThrow('STRIPE_CORRECTION_RETRY_KEY_EXPIRED');
    expect(fixture.client.invoices.create).toHaveBeenCalledTimes(3);
    fixture.items.in_supp_3 = [{ ...fixture.originalLines[0], invoice: 'in_supp_3' } as never];
    await expect(collectStripeCorrectionInvoice(fresh, deps())).rejects.toThrow('STRIPE_CORRECTION_LINES_UNPROVEN');
    expect(fixture.client.invoiceItems.create).toHaveBeenCalledTimes(2);
    await db.prisma.billingStripeCycleCorrection.update({ where: { id: pending.id },
      data: { leaseExpiresAt: new Date(Date.now() + 120_000),
        leaseToken: 'e5c70b32-0701-4c20-9bf5-e018e04725a8' } });
    await expect(collectStripeCorrectionInvoice(fresh, deps())).rejects.toThrow('STRIPE_CORRECTION_LEASE_BUSY');
    expect(fixture.client.invoices.create).toHaveBeenCalledTimes(3);
  });

  it('uses database time despite host clock drift and fences a worker whose lease expires before creation', async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL_REQUIRED');
    try {
      const local = await correctionFixture(handle.prisma);
      const request = { closeId: local.close.id, amountMicroMinor: 130_000_000n,
        cursor: 'bus_correction_1' };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
      try {
        local.client.invoices.list.mockImplementationOnce(async () => {
          await handle.prisma.$executeRaw(Prisma.sql`UPDATE billing_stripe_cycle_corrections
            SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE close_id = ${local.close.id}`);
          return { data: [], has_more: false };
        });
        await expect(collectStripeCorrectionInvoice(request,
          { prisma: handle.prisma, stripe: local.stripe })).rejects.toThrow('STRIPE_CORRECTION_LEASE_LOST');
        expect(local.client.invoices.create).not.toHaveBeenCalled();
        await collectStripeCorrectionInvoice(request, { prisma: handle.prisma, stripe: local.stripe });
        expect(local.client.invoices.create).toHaveBeenCalledOnce();
      } finally { clock.mockRestore(); }
    } finally { await handle.cleanup(); }
  });

  it('preserves an explicitly inclusive original VAT treatment while settling only net usage', async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL_REQUIRED');
    try {
      const inclusive = await correctionFixture(handle.prisma);
      inclusive.originalLines[0]!.amount = 1200;
      inclusive.originalLines[0]!.taxes[0]!.tax_behavior = 'inclusive';
      inclusive.rate.inclusive = true;
      expect((await invoicedStripeUsageAmountMinor(inclusive.stripe, handle.prisma,
        'in_original', inclusive.sub.id, 'USD')).amount).toBe(1000n);
      const request = { closeId: inclusive.close.id,
        amountMicroMinor: 130_000_000n, cursor: 'bus_correction_1' };
      const env = { prisma: handle.prisma, stripe: inclusive.stripe };
      const result = await collectStripeCorrectionInvoice(request, env);
      expect(inclusive.client.invoiceItems.create.mock.calls[0]?.[0]).toMatchObject({
        amount: 156, tax_behavior: 'inclusive', tax_rates: ['txr_20'] });
      expect(inclusive.invoices[result.stripeInvoiceId]).toMatchObject({ total: 156, auto_advance: true });
      inclusive.pay(result.stripeInvoiceId);
      await collectStripeCorrectionInvoice(request, env);
      const cash = await handle.prisma.billingStripePaymentInvoice.findFirstOrThrow({ include: { lines: true } });
      expect(cash.lines[0]).toMatchObject({ usageMinor: 130n, taxMinor: 26n, subscriptionMinor: 0n });
      expect((await handle.prisma.billingStripeInvoiceCloseResolution.findFirstOrThrow()).paidAmountMinor).toBe(130n);
    } finally { await handle.cleanup(); }
  });
});
