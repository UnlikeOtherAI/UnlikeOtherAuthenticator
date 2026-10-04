import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode, requireStripeBillingEnabled } from './billing-stripe-client.service.js';
import { reconcileStripeCycleInvoiceUsage } from './billing-stripe-invoice.service.js';
import { quoteUnexportedClosedPeriodLiability } from './billing-stripe-invoice-close-quote.service.js';

const INTERVAL_MS = 5 * 60_000;
const LEASE_MS = 10 * 60_000;

async function invoicedUsageAmountMinor(
  stripe: Pick<Stripe, 'invoices'>,
  prisma: PrismaClient,
  invoiceId: string,
  subscriptionId: string,
  currency: string,
): Promise<{ amount: bigint; lineIds: string[] }> {
  const subscription = await prisma.billingStripeSubscription.findUniqueOrThrow({
    where: { id: subscriptionId }, select: { stripeUsageItemId: true },
  });
  let amount = 0n;
  const lineIds: string[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const lines = await stripe.invoices.listLineItems(invoiceId, {
      limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const line of lines.data) {
      if (line.parent?.type !== 'subscription_item_details' ||
          line.parent.subscription_item_details?.subscription_item !== subscription.stripeUsageItemId) continue;
      if (line.currency.toUpperCase() !== currency || line.amount < 0) {
        throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_USAGE_LINE_INVALID');
      }
      amount += BigInt(line.amount);
      lineIds.push(line.id);
    }
    if (!lines.has_more) return { amount, lineIds };
    startingAfter = lines.data.at(-1)?.id;
    if (!startingAfter) break;
  }
  throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_USAGE_LINES_INCOMPLETE');
}

export async function runStripeInvoiceCloseCycle(deps?: {
  prisma?: PrismaClient;
  stripe?: Pick<Stripe, 'accounts' | 'billing' | 'invoices'>;
  now?: () => Date;
  reconcileInvoice?: typeof reconcileStripeCycleInvoiceUsage;
  quote?: typeof quoteUnexportedClosedPeriodLiability;
}): Promise<{ checked: number; held: number; unbilled: number }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const stripe = deps?.stripe ?? requireStripeBillingEnabled().client;
  const now = deps?.now?.() ?? new Date();
  const rows = await prisma.billingStripeInvoiceClose.findMany({
    where: {
      state: { in: ['HELD', 'READY', 'RELEASED', 'FINALIZED_HOLD', 'FINALIZED_CLEAR', 'COMPENSATED'] },
      nextCheckAt: { lte: now },
    },
    orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
    take: 50,
  });
  let currentStripeAccountId: string | undefined;
  let checked = 0;
  let held = 0;
  let unbilled = 0;
  for (const row of rows) {
    const claimed = await prisma.billingStripeInvoiceClose.updateMany({
      where: { id: row.id, state: row.state, nextCheckAt: { lte: now } },
      data: { nextCheckAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) continue;
    checked += 1;
    try {
      const account = await prisma.billingStripeAccount.findUniqueOrThrow({
        where: { id: row.accountId },
      });
      currentStripeAccountId ??= (await stripe.accounts.retrieveCurrent()).id;
      if (currentStripeAccountId !== account.stripeAccountId) {
        throw new AppError('INTERNAL', 409, 'STRIPE_ACCOUNT_MISMATCH');
      }
      const invoice = await stripe.invoices.retrieve(row.stripeInvoiceId);
      assertStripeObjectLivemode(invoice, account.livemode);
      if (invoice.id !== row.stripeInvoiceId) {
        throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_BINDING_INVALID');
      }
      if (invoice.status === 'draft') {
        if (row.state === 'READY') {
          if (row.readyAt && row.readyAt > now) {
            await prisma.billingStripeInvoiceClose.update({
              where: { id: row.id }, data: { nextCheckAt: row.readyAt },
            });
            continue;
          }
          const resumed = await stripe.invoices.update(invoice.id, { auto_advance: true });
          assertStripeObjectLivemode(resumed, account.livemode);
          if (resumed.id !== invoice.id || resumed.auto_advance !== true) {
            throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_RESUME_NOT_CONFIRMED');
          }
          await prisma.billingStripeInvoiceClose.update({
            where: { id: row.id }, data: {
              state: 'RELEASED', readyAt: null, lastError: null,
              nextCheckAt: new Date(now.getTime() + 60 * 60_000),
            },
          });
        } else if (row.state === 'HELD') {
          await (deps?.reconcileInvoice ?? reconcileStripeCycleInvoiceUsage)({
            invoiceId: invoice.id, eventType: 'catchup', account,
          }, { prisma, stripe, now: () => now });
        } else {
          await prisma.billingStripeInvoiceClose.update({
            where: { id: row.id },
            data: { nextCheckAt: new Date(now.getTime() + 60 * 60_000) },
          });
        }
        continue;
      }
      const billed = deps?.quote ? undefined : await invoicedUsageAmountMinor(
        stripe, prisma, invoice.id, row.subscriptionId, row.currency,
      );
      const priorResolutions = await prisma.billingStripeInvoiceCloseResolution.findMany({
        where: { closeId: row.id }, select: { paidAmountMinor: true },
      });
      const paidAdjustmentsAmountMinor = priorResolutions.reduce(
        (sum, resolution) => sum + resolution.paidAmountMinor, 0n,
      );
      const quote = await (deps?.quote ?? quoteUnexportedClosedPeriodLiability)({
        subscriptionId: row.subscriptionId, billingMonth: row.billingMonth,
        ...(billed === undefined ? {} : { invoicedUsageAmountMinor: billed.amount }),
        paidAdjustmentsAmountMinor,
      }, { prisma });
      if (quote.currency !== row.currency) {
        throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_CLOSE_CURRENCY_CHANGED');
      }
      await prisma.billingStripeInvoiceClose.update({
        where: { id: row.id },
        data: {
          state: quote.amountMicroMinor > 0n ? 'FINALIZED_HOLD' :
            (priorResolutions.length > 0 ? 'COMPENSATED' : 'FINALIZED_CLEAR'),
          ledgerSnapshotCursor: quote.ledgerSnapshotCursor,
          unbilledAmountMicroMinor: quote.amountMicroMinor,
          ...(billed === undefined ? {} : {
            invoicedUsageAmountMinor: billed.amount,
            invoicedUsageLineIds: billed.lineIds,
          }),
          lastError: quote.amountMicroMinor > 0n ? 'STRIPE_FINALIZED_USAGE_ADJUSTMENT_REQUIRED' : null,
          nextCheckAt: new Date(now.getTime() + 60 * 60_000),
        },
      });
      if (quote.amountMicroMinor > 0n) unbilled += 1;
    } catch (error) {
      held += 1;
      await prisma.billingStripeInvoiceClose.update({
        where: { id: row.id },
        data: {
          state: row.state,
          lastError: error instanceof AppError ? error.message : 'STRIPE_INVOICE_CLOSE_RETRY_REQUIRED',
          nextCheckAt: new Date(now.getTime() + 15 * 60_000),
        },
      });
    }
  }
  return { checked, held, unbilled };
}

export function startStripeInvoiceCloseScheduler(params: {
  log: { info: (details: object, message: string) => void; error: (details: object, message: string) => void };
  runCycle?: typeof runStripeInvoiceCloseCycle;
}): { stop: () => void } {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      params.log.info(await (params.runCycle ?? runStripeInvoiceCloseCycle)(),
        'Stripe invoice close catch-up cycle');
    } catch (error) {
      params.log.error({ error }, 'Stripe invoice close catch-up cycle failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
