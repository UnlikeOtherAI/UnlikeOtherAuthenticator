import { getAdminPrisma } from '../db/prisma.js';
import { getEnv } from '../config/env.js';
import { deliverCommercialEmails } from './billing-commercial-email.service.js';
import { dispatchStorageExpansion } from './billing-storage-expansion.service.js';

/** Persistent retry slots survive replicas/restarts; payment evidence owns outcomes. */
export async function runCommercialRecovery() {
  const prisma = getAdminPrisma();
  await deliverCommercialEmails();
  if (!getEnv().STRIPE_BILLING_ENABLED) return;
  const now = new Date();
  const work = await prisma.$queryRaw<Array<{ id: string; attempt_id: string }>>`
    SELECT e.id,a.id AS attempt_id FROM billing_storage_expansions e
    JOIN billing_storage_payment_attempts a ON a.expansion_id=e.id
    WHERE e.state IN('pending','processing','failed','reconciliation_required') AND a.next_attempt_at<=${now}
      AND NOT EXISTS(SELECT 1 FROM billing_storage_payment_attempts newer
        WHERE newer.expansion_id=e.id AND newer.generation>a.generation)
    ORDER BY a.next_attempt_at,a.id LIMIT 25`;
  for (const item of work) {
    const claimed = await prisma.billingStoragePaymentAttempt.updateMany({ where: { id: item.attempt_id,
      nextAttemptAt: { lte: now } }, data: { lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + 300_000) } });
    if (!claimed.count) continue;
    try { await dispatchStorageExpansion(item.id); } catch { /* committed next slot preserves recovery */ }
  }
}

export function startCommercialRecoveryScheduler(params: { log: { error: (details: object, message: string) => void } }) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await runCommercialRecovery(); } catch (error) {
      params.log.error({ err: error }, 'Commercial payment recovery failed');
    } finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, 60_000); timer.unref();
  return { stop: () => clearInterval(timer) };
}
