import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { observedBillingTime } from './billing-seat-observed-time.service.js';

const INTERVAL_MS = 5 * 60_000;

/** Closes evidence at observation time after a scheduled commercial end. */
export async function runSeatTransitionCycle(deps?: {
  prisma?: PrismaClient;
  now?: () => Date;
}): Promise<{ checked: number; closed: number }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? new Date();
  const due = await prisma.billingSeatSubscription.findMany({
    where: { contractServiceTermId: { not: null }, endedAt: null,
      commercialEndsAt: { lte: now } },
    select: { id: true }, orderBy: [{ commercialEndsAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  let closed = 0;
  for (const row of due) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const changed = await prisma.$transaction(async (tx) => {
          const observedAt = await observedBillingTime(tx);
          return tx.billingSeatSubscription.updateMany({
            where: { id: row.id, endedAt: null,
              commercialEndsAt: { lte: observedAt } },
            data: { endedAt: observedAt },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        closed += changed.count;
        break;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 'P2034' || attempt === 2) throw error;
      }
    }
  }
  return { checked: due.length, closed };
}

export function startSeatTransitionScheduler(params: {
  log: { info: (details: object, message: string) => void;
    error: (details: object, message: string) => void };
  runCycle?: typeof runSeatTransitionCycle;
}): { stop: () => void } {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      params.log.info(await (params.runCycle ?? runSeatTransitionCycle)(),
        'seat evidence transition cycle');
    } catch (error) {
      params.log.error({ error }, 'seat evidence transition cycle failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
