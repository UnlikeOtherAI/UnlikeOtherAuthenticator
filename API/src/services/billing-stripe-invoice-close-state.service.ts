import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

export type InvoiceCloseState = 'HELD' | 'READY' | 'RELEASED' | 'FINALIZED_HOLD' | 'FINALIZED_CLEAR' | 'COMPENSATED';

export async function recordStripeInvoiceClose(
  params: {
    accountId: string;
    subscriptionId: string;
    invoiceId: string;
    billingMonth: string;
    periodStartsAt: Date;
    periodEndsAt: Date;
    currency: string;
    state: InvoiceCloseState;
    ledgerSnapshotCursor?: string | null;
    readyAt?: Date | null;
    lastError?: string | null;
    now: Date;
  },
  prisma: PrismaClient,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.billingStripeInvoiceClose.findUnique({
      where: { stripeInvoiceId: params.invoiceId },
    });
    if (existing && (
      existing.accountId !== params.accountId ||
      existing.subscriptionId !== params.subscriptionId ||
      existing.billingMonth !== params.billingMonth ||
      existing.periodStartsAt.getTime() !== params.periodStartsAt.getTime() ||
      existing.periodEndsAt.getTime() !== params.periodEndsAt.getTime() ||
      existing.currency !== params.currency
    )) throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_CLOSE_BINDING_CHANGED');
    if (existing?.state === 'COMPENSATED') return existing;
    const nextCheckAt = params.state === 'READY'
      ? (params.readyAt ?? new Date(params.now.getTime() + 60 * 60_000))
      : new Date(params.now.getTime() + (params.state === 'HELD' ? 5 : 60) * 60_000);
    return tx.billingStripeInvoiceClose.upsert({
      where: { stripeInvoiceId: params.invoiceId },
      create: {
        accountId: params.accountId,
        subscriptionId: params.subscriptionId,
        stripeInvoiceId: params.invoiceId,
        billingMonth: params.billingMonth,
        periodStartsAt: params.periodStartsAt,
        periodEndsAt: params.periodEndsAt,
        currency: params.currency,
        state: params.state,
        ledgerSnapshotCursor: params.ledgerSnapshotCursor ?? null,
        readyAt: params.readyAt ?? null,
        nextCheckAt,
        lastError: params.lastError ?? null,
      },
      update: {
        state: params.state,
        ...(params.ledgerSnapshotCursor ? { ledgerSnapshotCursor: params.ledgerSnapshotCursor } : {}),
        readyAt: params.readyAt ?? null,
        nextCheckAt,
        lastError: params.lastError ?? null,
      },
    });
  });
}
