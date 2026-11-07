import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { stopArchivedTeamBilling } from './team-archive-billing.service.js';
import { observedBillingTime } from './billing-seat-observed-time.service.js';

/** A failed provider call leaves the original operation pending. Leases expire
 * after process loss; retries inspect provider state rather than re-admit work.
 */
export async function reconcileTeamArchives(deps?: {
  prisma?: PrismaClient; stopBilling?: typeof stopArchivedTeamBilling; now?: () => Date; operationId?: string;
}) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? await observedBillingTime(prisma);
  const rows = await prisma.teamArchiveOperation.findMany({ where: {
    billingStoppedAt: null, nextAttemptAt: { lte: now },
    ...(deps?.operationId ? { id: deps.operationId } : {}),
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
  }, orderBy: { nextAttemptAt: 'asc' }, take: 10 });
  let completed = 0, failed = 0;
  for (const row of rows) {
    const leaseOwner = randomUUID();
    const claimed = await prisma.teamArchiveOperation.updateMany({ where: {
      id: row.id, billingStoppedAt: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    }, data: { leaseOwner, leaseExpiresAt: new Date(now.getTime() + 120_000) } });
    if (!claimed.count) continue;
    let stopped = false;
    try { stopped = await (deps?.stopBilling ?? stopArchivedTeamBilling)(row, { prisma }); }
    catch { failed += 1; }
    const observedAt = deps?.now?.() ?? await observedBillingTime(prisma);
    const updated = await prisma.teamArchiveOperation.updateMany({ where: { id: row.id, leaseOwner }, data: {
      ...(stopped ? { billingStoppedAt: observedAt } : {}), leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: new Date(Math.max(observedAt.getTime() + 30_000, row.settleAfter.getTime())),
    } });
    if (stopped) completed += updated.count;
  }
  return { checked: rows.length, completed, failed };
}

export function startTeamArchiveReconciliation(params: {
  log: { error(details: object, message: string): void };
  runCycle?: typeof reconcileTeamArchives;
}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await (params.runCycle ?? reconcileTeamArchives)();
      if (result.failed) params.log.error(result, 'Team billing stop remains pending; reconciliation will retry');
    }
    catch { params.log.error({}, 'Team archive reconciliation failed; pending operations will retry'); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, 30_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
