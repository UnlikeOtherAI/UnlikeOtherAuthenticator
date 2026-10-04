import {
  BillingCreditPaymentInvoiceState,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import { issueCreditPaymentInvoice } from './billing-credit-payment-invoice-issue.service.js';

const INTERVAL_MS = 5 * 60_000;
const CLAIM_LEASE_MS = 15 * 60_000;
type Provider = Pick<Stripe, 'accounts' | 'checkout' | 'invoicePayments' | 'invoices'>;

function retryDelayMs(attempt: number): number {
  return Math.min(60, 5 * 2 ** Math.min(Math.max(attempt - 1, 0), 4)) * 60_000;
}

async function claimDueInvoices(
  prisma: PrismaClient,
  accountId: string,
  livemode: boolean,
  now: Date,
) {
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
  const claimed = await prisma.$queryRaw<Array<{ id: string; attemptCount: number }>>(Prisma.sql`
    WITH due AS (
      SELECT id FROM billing_credit_payment_invoices
      WHERE account_id = ${accountId} AND livemode = ${livemode}
        AND state IN ('PENDING', 'HELD', 'ISSUING')
        AND next_issue_attempt_at <= ${now}
      ORDER BY next_issue_attempt_at, id
      FOR UPDATE SKIP LOCKED LIMIT 50
    )
    UPDATE billing_credit_payment_invoices AS invoice
    SET issue_attempt_count = invoice.issue_attempt_count + 1,
        next_issue_attempt_at = ${leaseUntil},
        last_issue_error = NULL,
        updated_at = ${now}
    FROM due WHERE invoice.id = due.id
    RETURNING invoice.id, invoice.issue_attempt_count AS "attemptCount"
  `);
  return { claimed, leaseUntil };
}

async function deferUnissued(
  prisma: PrismaClient,
  id: string,
  leaseUntil: Date,
  attempt: number,
  now: Date,
  reason: string,
) {
  await prisma.billingCreditPaymentInvoice.updateMany({
    where: {
      id,
      state: { in: [
        BillingCreditPaymentInvoiceState.PENDING,
        BillingCreditPaymentInvoiceState.HELD,
        BillingCreditPaymentInvoiceState.ISSUING,
      ] },
      nextIssueAttemptAt: leaseUntil,
    },
    data: {
      nextIssueAttemptAt: new Date(now.getTime() + retryDelayMs(attempt)),
      lastIssueError: reason.slice(0, 160),
    },
  });
}

export async function runCreditPaymentInvoiceCycle(deps?: {
  prisma?: PrismaClient;
  stripe?: Provider;
  livemode?: boolean;
  issue?: typeof issueCreditPaymentInvoice;
  now?: () => Date;
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
  const now = deps?.now?.() ?? new Date();
  const { claimed: rows, leaseUntil } = await claimDueInvoices(
    prisma, account.id, account.livemode, now,
  );
  const failures: Array<{ id: string; error: string }> = [];
  let issued = 0;
  let held = 0;
  for (const row of rows) {
    try {
      const result = await (deps?.issue ?? issueCreditPaymentInvoice)(row.id, {
        prisma, provider: runtime.client,
      });
      if (result.state === BillingCreditPaymentInvoiceState.ISSUED) issued += 1;
      else {
        held += 1;
        await deferUnissued(prisma, row.id, leaseUntil, row.attemptCount, now,
          result.holdReason ?? 'BILLING_CREDIT_INVOICE_PENDING_DOCUMENT');
      }
    } catch (error) {
      const reason = error instanceof AppError
        ? error.message : 'BILLING_CREDIT_INVOICE_ISSUE_FAILED';
      await deferUnissued(prisma, row.id, leaseUntil, row.attemptCount, now, reason);
      failures.push({
        id: row.id,
        error: reason,
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
