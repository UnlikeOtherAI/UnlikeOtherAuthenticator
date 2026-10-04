import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { runBillingCycleCloseBatch } from './billing-cycle-close-run.service.js';
import {
  seedHistoricalBillingCycleWatches, seedRecentBillingCycleWatches,
} from './billing-cycle-close-seed.service.js';

const INTERVAL_MS = 5 * 60_000;
const RECENT_SEED_INTERVAL_MS = 60 * 60_000;
const MAX_BATCHES = 4;

export async function runBillingCycleCloseCycle(deps?: {
  prisma?: PrismaClient; now?: Date; recent?: boolean;
  runBatch?: typeof runBillingCycleCloseBatch;
}): Promise<{ seeded: number; checked: number; held: number; backlog: number }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now ?? new Date();
  let seeded = deps?.recent === false ? 0 :
    await seedRecentBillingCycleWatches({ prisma, now });
  for (const kind of ['stripe', 'manual', 'team_discovery'] as const) {
    const result = await seedHistoricalBillingCycleWatches(kind, { prisma, now });
    seeded += result.inserted;
  }
  let checked = 0;
  let held = 0;
  let backlog = 0;
  for (let index = 0; index < MAX_BATCHES; index += 1) {
    const result = await (deps?.runBatch ?? runBillingCycleCloseBatch)({ prisma, now });
    checked += result.checked;
    held += result.held;
    backlog = result.backlog;
    if (result.checked < 50) break;
  }
  return { seeded, checked, held, backlog };
}

/** A timer only wakes the durable queue; another instance can resume its lease. */
export function startBillingCycleCloseScheduler(params: {
  log: { info: (details: object, message: string) => void;
    error: (details: object, message: string) => void };
  runCycle?: typeof runBillingCycleCloseCycle;
}): { stop: () => void } {
  let running = false;
  let nextRecentSeedAt = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const recent = Date.now() >= nextRecentSeedAt;
      const result = await (params.runCycle ?? runBillingCycleCloseCycle)({ recent });
      params.log.info(result, 'closed billing cycle catch-up');
      if (recent) nextRecentSeedAt = Date.now() + RECENT_SEED_INTERVAL_MS;
    } catch {
      params.log.error({ code: 'BILLING_CYCLE_CLOSE_WORKER_FAILED' },
        'closed billing cycle catch-up failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
