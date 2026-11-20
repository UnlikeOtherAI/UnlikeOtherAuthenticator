import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { sendProductDeletionEmail } from './email.service.js';

type Log = { warn: (fields: Record<string, unknown>, message: string) => void };

// Claim a bounded batch. An expired claim retries delivery after failure or process restart.
export async function deliverProductDeletionNotices(log: Log) {
  const db = getAdminPrisma();
  const now = new Date();
  const jobs = await db.productErasureJob.findMany({
    where: { completedAt: { not: null }, noticeDueAt: { lte: now } }, orderBy: { noticeDueAt: 'asc' }, take: 25,
    select: { id: true, subject: true, rejoinedSubject: true, policy: { select: { name: true } } },
  });
  for (const job of jobs) {
    const lease = new Date(Date.now() + 15 * 60_000);
    const claimed = await db.productErasureJob.updateMany({ where: { id: job.id, noticeDueAt: { lte: now } }, data: { noticeDueAt: lease } });
    if (!claimed.count) continue;
    const user = await db.user.findUnique({ where: { id: job.rejoinedSubject ?? job.subject }, select: { email: true } });
    try {
      if (user?.email) {
        const receiptUrl = new URL('/auth/delete-account/receipt/' + job.id, getPublicBaseUrl()).href;
        await sendProductDeletionEmail(user.email, job.policy.name, receiptUrl);
      }
      await db.productErasureJob.updateMany({ where: { id: job.id, noticeDueAt: lease }, data: { noticeDueAt: null } });
    } catch {
      log.warn({ code: 'PRODUCT_DELETION_NOTICE_PENDING' }, 'Product deletion completion email will retry');
    }
  }
}

export function startProductDeletionNotices(log: Log) {
  let running: Promise<void> | undefined;
  let nextOverdueCheck = 0;
  async function run() {
    await deliverProductDeletionNotices(log);
    if (Date.now() >= nextOverdueCheck) {
      const pending = await getAdminPrisma().productErasureJob.count({ where: { completedAt: null, createdAt: { lt: new Date(Date.now() - 86400000) } } });
      if (pending) log.warn({ code: 'PRODUCT_ERASURE_PENDING', count: pending }, 'Product deletions awaiting action for more than one day in Admin Apps');
      nextOverdueCheck = Date.now() + 3600000;
    }
  }
  function tick() {
    running ??= run().catch(() => log.warn({ code: 'PRODUCT_DELETION_DELIVERY_UNAVAILABLE' }, 'Product deletion delivery will retry'))
      .finally(() => { running = undefined; });
  }
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return { stop: async () => { clearInterval(timer); await running; } };
}
