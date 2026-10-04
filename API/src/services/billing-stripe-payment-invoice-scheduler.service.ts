import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { issueStripePaymentInvoice } from './billing-stripe-payment-invoice-issue.service.js';
import { type StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';

const INTERVAL_MS = 5 * 60_000;
const LEASE_MS = 15 * 60_000;
type Provider = StripeInvoiceCashClient & Pick<Stripe, 'accounts' | 'subscriptions'>;

export async function runStripePaymentInvoiceCycle(deps?: {
  prisma?: PrismaClient; stripe?: Provider; livemode?: boolean; now?: () => Date;
  issue?: typeof issueStripePaymentInvoice;
}) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const runtime = deps?.stripe ? { client: deps.stripe, livemode: deps.livemode } : requireStripeBillingEnabled();
  if (runtime.livemode === undefined) throw new Error('STRIPE_PAYMENT_INVOICE_MODE_REQUIRED');
  const account = await resolveStripeAccountContext(runtime.client, runtime.livemode, prisma);
  const now = deps?.now?.() ?? new Date();
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ id: string; attempt: number }>>(Prisma.sql`
    WITH due AS (
      SELECT id FROM billing_stripe_payment_invoices WHERE account_id = ${account.id}
        AND livemode = ${account.livemode} AND state IN ('PENDING', 'HELD')
        AND next_issue_attempt_at <= ${now} ORDER BY next_issue_attempt_at, id
      FOR UPDATE SKIP LOCKED LIMIT 50
    ) UPDATE billing_stripe_payment_invoices AS source
      SET issue_attempt_count = source.issue_attempt_count + 1,
        next_issue_attempt_at = ${lease}, updated_at = ${now}
      FROM due WHERE source.id = due.id RETURNING source.id, source.issue_attempt_count AS attempt
  `);
  let issued = 0; let held = 0;
  for (const row of rows) {
    try {
      const result = await (deps?.issue ?? issueStripePaymentInvoice)(row.id, {
        prisma, stripe: runtime.client, account,
      });
      if (result.state !== 'ISSUED') throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_PENDING');
      issued += 1;
    } catch (error) {
      held += 1;
      await prisma.billingStripePaymentInvoice.updateMany({
        where: { id: row.id, state: { not: 'ISSUED' }, nextIssueAttemptAt: lease },
        data: { state: 'HELD', holdReason: error instanceof AppError ? error.message.slice(0, 160) :
          'STRIPE_PAYMENT_INVOICE_DOCUMENT_UNAVAILABLE',
        nextIssueAttemptAt: new Date(now.getTime() + Math.min(60,
          5 * 2 ** Math.min(row.attempt - 1, 4)) * 60_000) },
      });
    }
  }
  return { checked: rows.length, issued, held };
}

export function startStripePaymentInvoiceScheduler(params: {
  log: { info(details: object, message: string): void; error(details: object, message: string): void };
  runCycle?: typeof runStripePaymentInvoiceCycle;
}): { stop(): void } {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { params.log.info(await (params.runCycle ?? runStripePaymentInvoiceCycle)(),
      'Stripe subscription payment invoice document cycle'); }
    catch (error) { params.log.error({ error }, 'Stripe subscription payment invoice document cycle failed'); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS); timer.unref();
  return { stop: () => clearInterval(timer) };
}
