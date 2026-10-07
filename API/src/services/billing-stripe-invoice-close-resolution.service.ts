import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode, requireStripeBillingEnabled } from './billing-stripe-client.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice }
  from './billing-stripe-payment-invoice-source.service.js';
import { stripeInvoiceMinor, verifyStripeInvoiceCash, type StripeInvoiceCashClient }
  from './billing-stripe-payment-evidence.service.js';

export async function listHeldStripeInvoiceCloses(deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const rows = await prisma.billingStripeInvoiceClose.findMany({
    where: { state: { in: ['HELD', 'READY', 'FINALIZED_HOLD'] } },
    orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  return rows.map((row) => ({
    id: row.id,
    subscription_id: row.subscriptionId,
    stripe_invoice_id: row.stripeInvoiceId,
    billing_month: row.billingMonth,
    state: row.state.toLowerCase(),
    currency: row.currency,
    ledger_snapshot_cursor: row.ledgerSnapshotCursor,
    unbilled_amount_micro_minor: row.unbilledAmountMicroMinor?.toString() ?? null,
    last_error: row.lastError,
  }));
}

export async function compensateFinalizedStripeInvoice(
  params: {
    closeId: string;
    adjustmentInvoiceId: string;
    actorEmail: string;
    observedAt: Date;
    now?: Date;
    correctionId?: string;
  },
  deps?: { prisma?: PrismaClient; stripe?: Pick<Stripe, 'accounts' | 'subscriptions'> & StripeInvoiceCashClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const stripe = deps?.stripe ?? requireStripeBillingEnabled().client;
  const now = params.now ?? new Date();
  if (!/^in_[A-Za-z0-9_]+$/.test(params.adjustmentInvoiceId) ||
      Number.isNaN(params.observedAt.getTime()) || params.observedAt > now) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_INVOICE_ADJUSTMENT_EVIDENCE_INVALID');
  }
  const remote = await stripe.invoices.retrieve(params.adjustmentInvoiceId);
  const remoteAccount = await stripe.accounts.retrieveCurrent();
  const remoteLines = await stripe.invoices.listLineItems(params.adjustmentInvoiceId, { limit: 2 });
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "billing_stripe_invoice_closes" WHERE "id" = ${params.closeId} FOR UPDATE
    `);
    if (locked.length !== 1) throw new AppError('NOT_FOUND', 404, 'STRIPE_INVOICE_CLOSE_NOT_FOUND');
    const close = await tx.billingStripeInvoiceClose.findUniqueOrThrow({
      where: { id: params.closeId },
      include: { subscription: { include: { customer: true, account: true } } },
    });
    const correction = params.correctionId ?
      await tx.billingStripeCycleCorrection.findUnique({ where: { id: params.correctionId } }) : null;
    if (params.correctionId && (!correction || correction.closeId !== close.id ||
      correction.stripeInvoiceId !== remote.id || correction.currency !== close.currency)) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_CYCLE_CORRECTION_SOURCE_UNPROVEN');
    }
    if (correction?.paidAt) {
      const prior = await tx.billingStripeInvoiceCloseResolution.findUnique({
        where: { stripeAdjustmentInvoiceId: remote.id } });
      if (!prior || prior.closeId !== close.id || prior.paidAmountMinor !== correction.amountMinor) {
        throw new AppError('INTERNAL', 409, 'STRIPE_CYCLE_CORRECTION_PAYMENT_UNPROVEN');
      }
      return { close_id: close.id, state: 'compensated' as const };
    }
    if (close.state !== 'FINALIZED_HOLD' || !close.unbilledAmountMicroMinor ||
        !close.ledgerSnapshotCursor) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_INVOICE_ADJUSTMENT_NOT_READY');
    }
    assertStripeObjectLivemode(remote, close.subscription.account.livemode);
    const remoteCustomer = typeof remote.customer === 'string'
      ? remote.customer : remote.customer?.id;
    const expectedMinor = correction?.amountMinor ??
      (close.unbilledAmountMicroMinor + 500_000n) / 1_000_000n;
    if (correction && expectedMinor > (close.unbilledAmountMicroMinor + 500_000n) / 1_000_000n) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_CYCLE_CORRECTION_EXCEEDS_CURRENT_LIABILITY');
    }
    const expectedMetadata = {
      uoa_source_close_id: close.id,
      uoa_source_invoice_id: close.stripeInvoiceId,
      uoa_source_subscription_id: close.subscriptionId,
      uoa_source_service_id: close.subscription.serviceId,
      uoa_source_billing_month: close.billingMonth,
      uoa_source_period_start: close.periodStartsAt.toISOString(),
      uoa_source_period_end: close.periodEndsAt.toISOString(),
    };
    const line = remoteLines.data[0];
    const metadataMatches = (metadata: Record<string, string> | null | undefined) =>
      Object.entries(expectedMetadata).every(([key, value]) => metadata?.[key] === value);
    if (remote.id !== params.adjustmentInvoiceId || remote.id === close.stripeInvoiceId ||
        remoteAccount.id !== close.subscription.account.stripeAccountId ||
        close.accountId !== close.subscription.accountId ||
        remote.status !== 'paid' || remote.billing_reason !== 'manual' ||
        remoteCustomer !== close.subscription.customer.stripeCustomerId ||
        remote.currency.toUpperCase() !== close.currency ||
        remote.amount_paid !== remote.amount_due || remote.amount_remaining !== 0 ||
        remote.amount_due !== remote.total ||
        !metadataMatches(remote.metadata) ||
        remoteLines.has_more || remoteLines.data.length !== 1 ||
        !line || line.invoice !== remote.id || line.livemode !== remote.livemode ||
        line.period.start !== close.periodStartsAt.getTime() / 1000 ||
        line.period.end !== close.periodEndsAt.getTime() / 1000 ||
        line.taxes === null ||
        line.discount_amounts?.some((item) => item.amount !== 0) ||
        line.pretax_credit_amounts?.some((item) => item.amount !== 0) ||
        line.currency.toUpperCase() !== close.currency ||
        !metadataMatches(line.metadata)) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_INVOICE_ADJUSTMENT_EVIDENCE_MISMATCH');
    }
    const taxes = line.taxes ?? [];
    const inclusiveTax = taxes.filter((tax) => tax.tax_behavior === 'inclusive')
      .reduce((sum, tax) => sum + stripeInvoiceMinor(tax.amount), 0n);
    const tax = taxes.reduce((sum, row) => sum + stripeInvoiceMinor(row.amount), 0n);
    if (stripeInvoiceMinor(line.amount) - inclusiveTax !== expectedMinor ||
      stripeInvoiceMinor(remote.total) !== expectedMinor + tax ||
      remote.total_taxes === null || tax !== remote.total_taxes.reduce((sum, row) =>
        sum + stripeInvoiceMinor(row.amount), 0n)) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_INVOICE_ADJUSTMENT_EVIDENCE_MISMATCH');
    }
    // A paid status also permits out-of-band marking. Only captured processor
    // cash can satisfy a late financial liability; tax does not reduce usage.
    await verifyStripeInvoiceCash(remote, stripe);
    await tx.billingStripeInvoiceCloseResolution.create({
      data: {
        closeId: close.id,
        stripeAdjustmentInvoiceId: remote.id,
        stripeAdjustmentLineId: line.id,
        amountMicroMinor: correction ? expectedMinor * 1_000_000n : close.unbilledAmountMicroMinor,
        paidAmountMinor: expectedMinor,
        ledgerSnapshotCursor: correction?.ledgerSnapshotCursor ?? close.ledgerSnapshotCursor,
        actorEmail: params.actorEmail,
        observedAt: params.observedAt,
      },
    });
    await tx.billingStripeInvoiceClose.update({
      where: { id: close.id }, data: { state: 'COMPENSATED', lastError: null },
    });
    // Webhooks may precede the operator binding. Insert the verified legal
    // invoice source in this transaction so document issuance cannot be lost.
    const source = await prepareStripePaymentInvoice(remote.id,
      close.subscription.account, tx as unknown as PrismaClient, stripe);
    if (!source) throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_ADJUSTMENT_SOURCE_UNPROVEN');
    await persistStripePaymentInvoice(tx, source);
    if (correction) {
      await tx.billingStripeCycleCorrection.update({ where: { id: correction.id },
        data: { paidAt: params.observedAt } });
    }

    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actorEmail,
        action: 'billing.stripe_invoice_close_compensated',
        metadata: {
          close_id: close.id, subscription_id: close.subscriptionId,
          source_invoice_id: close.stripeInvoiceId,
          adjustment_invoice_id: remote.id,
          adjustment_line_id: line.id,
          billing_month: close.billingMonth,
          ledger_snapshot_cursor: close.ledgerSnapshotCursor,
          amount_micro_minor: close.unbilledAmountMicroMinor.toString(),
        },
      },
    });
    return { close_id: close.id, state: 'compensated' as const };
  }, { timeout: 30_000 });
}
