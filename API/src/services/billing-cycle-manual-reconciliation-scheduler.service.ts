import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { refreshIssuedManualBillingCyclePayment } from './billing-cycle-manual-payment.service.js';
import { refreshVoidedManualBillingCycle } from './billing-cycle-manual-void.service.js';

const INTERVAL_MS = 5 * 60_000;
const BATCH_SIZE = 50;

/** Cycle effects are revisited independently of customer reads and admin retries. */
export async function runManualCycleReconciliationBatch(
  params?: { afterId?: string | null },
  deps?: { prisma?: PrismaClient;
    refreshPayment?: typeof refreshIssuedManualBillingCyclePayment;
    refreshVoid?: typeof refreshVoidedManualBillingCycle },
): Promise<{ checked: number; held: number; nextId: string | null;
  failures: Array<{ invoiceId: string; code: string }> }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const rows = await prisma.billingCustomerCycleInvoiceAllocation.findMany({
    where: { sourceKind: 'manual',
      ...(params?.afterId ? { id: { gt: params.afterId } } : {}) },
    select: { id: true, sourceInvoiceId: true }, orderBy: { id: 'asc' },
    take: BATCH_SIZE,
  });
  let held = 0;
  const failures: Array<{ invoiceId: string; code: string }> = [];
  for (const row of rows) {
    try {
      const invoice = await prisma.billingInvoice.findUnique({
        where: { id: row.sourceInvoiceId }, select: { status: true },
      });
      if (invoice?.status === 'VOID') {
        await (deps?.refreshVoid ?? refreshVoidedManualBillingCycle)(
          { invoiceId: row.sourceInvoiceId }, { prisma });
      } else if (invoice?.status === 'ISSUED') {
        await (deps?.refreshPayment ?? refreshIssuedManualBillingCyclePayment)(
          { invoiceId: row.sourceInvoiceId }, { prisma });
      } else held += 1;
    } catch (error) {
      // Preserve the append-only source. The next bounded sweep retries it.
      held += 1;
      failures.push({ invoiceId: row.sourceInvoiceId,
        code: error instanceof Error ? error.message : 'UNKNOWN_RECONCILIATION_FAILURE' });
    }
  }
  return { checked: rows.length, held,
    nextId: rows.length === BATCH_SIZE ? rows.at(-1)?.id ?? null : null, failures };
}

export function startManualCycleReconciliationScheduler(params: {
  log: { info: (details: object, message: string) => void;
    error: (details: object, message: string) => void };
  runBatch?: typeof runManualCycleReconciliationBatch;
}): { stop: () => void } {
  let running = false;
  let afterId: string | null = null;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await (params.runBatch ?? runManualCycleReconciliationBatch)({ afterId });
      afterId = result.nextId;
      params.log.info(result, 'manual billing cycle reconciliation');
    } catch (error) {
      params.log.error({ error }, 'manual billing cycle reconciliation failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
