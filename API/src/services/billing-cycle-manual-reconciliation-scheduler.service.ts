import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { refreshIssuedManualBillingCyclePayment } from './billing-cycle-manual-payment.service.js';
import { refreshVoidedManualBillingCycle } from './billing-cycle-manual-void.service.js';

const INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_TICK = 4;

type Claimed = { invoiceId: string; generation: bigint; leaseToken: string; attempts: number };

async function claimDue(prisma: PrismaClient): Promise<Claimed[]> {
  const leaseToken = randomUUID();
  return prisma.$queryRaw<Claimed[]>(Prisma.sql`
    WITH due AS (
      SELECT invoice_id
      FROM billing_manual_cycle_reconciliation_queue
      WHERE due_at <= now() AND
        (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY priority, due_at, invoice_id
      FOR UPDATE SKIP LOCKED LIMIT ${BATCH_SIZE}
    )
    UPDATE billing_manual_cycle_reconciliation_queue AS queue
    SET lease_token = ${leaseToken}, lease_expires_at = now() + interval '2 minutes',
        attempts = attempts + 1, updated_at = now()
    FROM due WHERE queue.invoice_id = due.invoice_id
    RETURNING queue.invoice_id AS "invoiceId", queue.generation,
      queue.lease_token AS "leaseToken", queue.attempts
  `);
}

function failureCode(error: unknown): string {
  if (error instanceof AppError && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message)) {
    return error.message;
  }
  return 'BILLING_CYCLE_RECONCILIATION_FAILED';
}

async function acknowledge(prisma: PrismaClient, item: Claimed): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM billing_manual_cycle_reconciliation_queue
    WHERE invoice_id = ${item.invoiceId} AND generation = ${item.generation}
      AND lease_token = ${item.leaseToken}
  `);
}

async function retry(prisma: PrismaClient, item: Claimed, code: string): Promise<void> {
  const seconds = Math.min(3600, 30 * 2 ** Math.min(item.attempts, 7));
  await prisma.$executeRaw(Prisma.sql`
    UPDATE billing_manual_cycle_reconciliation_queue
    SET due_at = now() + ${seconds} * interval '1 second',
      lease_token = NULL, lease_expires_at = NULL,
      last_error_code = ${code}, updated_at = now()
    WHERE invoice_id = ${item.invoiceId} AND generation = ${item.generation}
      AND lease_token = ${item.leaseToken}
  `);
}

/** Claims only durable changed financial sources; a worker crash releases its lease. */
export async function runManualCycleReconciliationBatch(
  deps?: { prisma?: PrismaClient;
    refreshPayment?: typeof refreshIssuedManualBillingCyclePayment;
    refreshVoid?: typeof refreshVoidedManualBillingCycle },
): Promise<{ checked: number; held: number; failures: Array<{ invoiceId: string; code: string }> }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const rows = await claimDue(prisma);
  let held = 0;
  const failures: Array<{ invoiceId: string; code: string }> = [];
  for (const row of rows) {
    try {
      const invoice = await prisma.billingInvoice.findUnique({
        where: { id: row.invoiceId }, select: { status: true },
      });
      if (invoice?.status === 'VOID') {
        const refreshed = await (deps?.refreshVoid ?? refreshVoidedManualBillingCycle)(
          { invoiceId: row.invoiceId }, { prisma });
        if (!refreshed) throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_ALLOCATION_MISSING');
      } else if (invoice?.status === 'ISSUED') {
        await (deps?.refreshPayment ?? refreshIssuedManualBillingCyclePayment)(
          { invoiceId: row.invoiceId }, { prisma });
      } else {
        throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_INVOICE_STATE_UNRESOLVED');
      }
      await acknowledge(prisma, row);
    } catch (error) {
      // The queue and immutable financial source survive. Never log SQL or
      // provider exception text beside customer/invoice identifiers.
      const code = failureCode(error);
      await retry(prisma, row, code);
      held += 1;
      failures.push({ invoiceId: row.invoiceId, code });
    }
  }
  return { checked: rows.length, held, failures };
}

export function startManualCycleReconciliationScheduler(params: {
  log: { info: (details: object, message: string) => void;
    error: (details: object, message: string) => void };
  runBatch?: typeof runManualCycleReconciliationBatch;
}): { stop: () => void } {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      let checked = 0;
      let held = 0;
      for (let index = 0; index < MAX_BATCHES_PER_TICK; index += 1) {
        const result = await (params.runBatch ?? runManualCycleReconciliationBatch)();
        checked += result.checked;
        held += result.held;
        if (result.checked < BATCH_SIZE) break;
      }
      params.log.info({ checked, held }, 'manual billing cycle reconciliation');
    } catch (error) {
      params.log.error({ code: failureCode(error) }, 'manual billing cycle reconciliation failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
