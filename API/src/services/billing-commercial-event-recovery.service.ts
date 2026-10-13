import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { assertStripeEventAccount, assertStripeEventApiVersion } from './billing-stripe-webhook-event.service.js';
import { applyTrustedCommercialStripeEvent, COMMERCIAL_RECOVERY_EVENT_TYPES } from './billing-stripe-webhook.service.js';

/** Each window/page and original Event has durable independent progress. */
export async function recoverCommercialStripeEvents(params: { prisma: PrismaClient; stripe: Stripe; livemode: boolean;
  now?: Date; apply?: typeof applyTrustedCommercialStripeEvent }) {
  const { prisma, stripe } = params;
  const now = params.now ?? new Date();
  const account = await resolveStripeAccountContext(stripe, params.livemode, prisma);
  const second = Math.floor(now.getTime() / 1000);
  const scan = await prisma.billingCommercialEventScan.upsert({ where: { accountId: account.id },
    create: { accountId: account.id, fromSecond: second - 30 * 86_400, throughSecond: second }, update: {} });
  if (scan.nextAttemptAt <= now) {
    const claimed = await prisma.billingCommercialEventScan.updateMany({ where: { accountId: account.id,
      generation: scan.generation, nextAttemptAt: { lte: now } }, data: { nextAttemptAt: new Date(now.getTime() + 60_000) } });
    if (claimed.count) {
      const page = await stripe.events.list({ types: COMMERCIAL_RECOVERY_EVENT_TYPES, limit: 100,
        created: { gte: scan.fromSecond, lte: scan.throughSecond }, ...(scan.cursor ? { starting_after: scan.cursor } : {}) });
      for (const event of page.data) {
        assertStripeEventAccount(event, account);
        if (!COMMERCIAL_RECOVERY_EVENT_TYPES.includes(event.type) || event.created < scan.fromSecond || event.created > scan.throughSecond) {
          throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_COMMERCIAL_EVENT_SCAN_DRIFT');
        }
      }
      const cursor = page.data.at(-1)?.id;
      if (page.has_more && (!cursor || cursor === scan.cursor)) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_COMMERCIAL_EVENT_SCAN_UNRESOLVED');
      }
      await prisma.$transaction(async (tx) => {
        // Commit page admissions and the cursor together: crash replay is harmless.
        for (const event of page.data) await tx.billingCommercialEventRecovery.upsert({ where: {
          accountId_eventId: { accountId: account.id, eventId: event.id },
        }, create: { accountId: account.id, eventId: event.id, eventType: event.type, objectId: event.data.object.id }, update: {} });
        await tx.billingCommercialEventScan.updateMany({ where: { accountId: account.id, generation: scan.generation },
          data: { generation: { increment: 1 }, ...(page.has_more ? { cursor } : {
            // Overlap the completion second; verified event identity deduplicates it.
            cursor: null, fromSecond: scan.throughSecond, throughSecond: Math.max(scan.throughSecond, second),
          }) } });
      });
    }
  }
  const work = await prisma.billingCommercialEventRecovery.findMany({ where: { accountId: account.id,
    completedAt: null, nextAttemptAt: { lte: now } }, orderBy: [{ nextAttemptAt: 'asc' }, { eventId: 'asc' }], take: 25 });
  for (const row of work) {
    const where = { accountId: row.accountId, eventId: row.eventId, completedAt: null, nextAttemptAt: { lte: now } };
    const claimed = await prisma.billingCommercialEventRecovery.updateMany({ where,
      data: { nextAttemptAt: new Date(now.getTime() + 300_000), attemptCount: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      const event = await stripe.events.retrieve(row.eventId);
      assertStripeEventAccount(event, account); assertStripeEventApiVersion(event);
      if (event.id !== row.eventId || event.type !== row.eventType || event.data.object.id !== row.objectId) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_COMMERCIAL_EVENT_RECOVERY_DRIFT');
      }
      await (params.apply ?? applyTrustedCommercialStripeEvent)({ event, stripe, account, prisma });
      await prisma.billingCommercialEventRecovery.updateMany({ where: { accountId: row.accountId,
        eventId: row.eventId, completedAt: null }, data: { completedAt: now } });
    } catch { /* independently persisted retry slot cannot starve later invoices */ }
  }
}
