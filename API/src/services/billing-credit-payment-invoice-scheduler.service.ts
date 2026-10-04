import {
  BillingCreditPaymentInvoiceState,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import { issueCreditPaymentInvoice } from './billing-credit-payment-invoice-issue.service.js';

const INTERVAL_MS = 5 * 60_000;
type Provider = Pick<Stripe, 'accounts' | 'checkout' | 'invoicePayments' | 'invoices'>;

export async function runCreditPaymentInvoiceCycle(deps?: {
  prisma?: PrismaClient;
  stripe?: Provider;
  livemode?: boolean;
  issue?: typeof issueCreditPaymentInvoice;
}) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const runtime = deps?.stripe
    ? { client: deps.stripe, livemode: deps.livemode }
    : requireStripeBillingEnabled();
  if (runtime.livemode === undefined) {
    throw new Error('BILLING_CREDIT_INVOICE_MODE_REQUIRED');
  }
  const account = await resolveStripeAccountContext(
    runtime.client, runtime.livemode, prisma,
  );
  const rows = await prisma.billingCreditPaymentInvoice.findMany({
    where: {
      accountId: account.id,
      livemode: account.livemode,
      state: { in: [
        BillingCreditPaymentInvoiceState.PENDING,
        BillingCreditPaymentInvoiceState.HELD,
        BillingCreditPaymentInvoiceState.ISSUING,
      ] },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: 50,
    select: { id: true },
  });
  const failures: Array<{ id: string; error: string }> = [];
  let issued = 0;
  let held = 0;
  for (const row of rows) {
    try {
      const result = await (deps?.issue ?? issueCreditPaymentInvoice)(row.id, {
        prisma, provider: runtime.client,
      });
      if (result.state === BillingCreditPaymentInvoiceState.ISSUED) issued += 1;
      else held += 1;
    } catch (error) {
      failures.push({
        id: row.id,
        error: error instanceof Error ? error.message : 'UNKNOWN_ISSUE_FAILURE',
      });
    }
  }
  return { attempted: rows.length, issued, held, failures };
}

export function startCreditPaymentInvoiceScheduler(params: {
  log: {
    info: (details: object, message: string) => void;
    error: (details: object, message: string) => void;
  };
  runCycle?: typeof runCreditPaymentInvoiceCycle;
}): { stop: () => void } {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await (params.runCycle ?? runCreditPaymentInvoiceCycle)();
      if (result.failures.length > 0) {
        params.log.error(result, 'Stripe prepaid legal invoice cycle incomplete');
      } else {
        params.log.info(result, 'Stripe prepaid legal invoice cycle');
      }
    } catch (error) {
      params.log.error({ err: error }, 'Stripe prepaid legal invoice cycle failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
