import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import type { StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';
import { collectAnniversarySeat } from './billing-anniversary-seat-collection.service.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';

type Provider = StripeInvoiceCashClient & Pick<Stripe, 'accounts' | 'subscriptions' | 'events' | 'customers'>;

export async function runAnniversarySeatCycle(deps?: {
  prisma?: PrismaClient; stripe?: Provider; livemode?: boolean; now?: () => Date; inviteId?: string;
}) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? new Date();
  if (!deps?.inviteId) await prisma.$queryRaw`SELECT billing_expire_invitation_seats(25)`;
  const due = await prisma.billingAutomaticSeatChange.findFirst({ where: {
    completedAt: null, nextAttemptAt: { lte: now },
    ...(deps?.inviteId ? { inviteId: deps.inviteId } : {}),
  }, select: { id: true } });
  if (!due) return 0;
  const runtime = deps?.stripe ? { client: deps.stripe, livemode: deps.livemode } : requireStripeBillingEnabled();
  if (runtime.livemode === undefined) throw new Error('STRIPE_SEAT_MODE_REQUIRED');
  const account = await resolveStripeAccountContext(runtime.client, runtime.livemode, prisma);
  let processed = 0;
  for (; processed < 25; processed++) {
    // Commit the attempt start and lease before contacting Stripe. A restarted process uses the
    // same operation key. The first unfinished transition blocks later ones for that subscription.
    const [claim] = await prisma.$queryRaw<Array<{ id: bigint }>>`
      WITH candidate AS (
        SELECT c.id FROM billing_automatic_seat_changes c
        JOIN billing_seat_subscriptions s ON s.id=c.seat_subscription_id
        JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
        WHERE b.account_id=${account.id} AND b.livemode=${account.livemode}
          AND b.initial_seat_invoice_id IS NOT NULL
          AND c.completed_at IS NULL AND c.next_attempt_at <= ${now}
          AND (${deps?.inviteId ?? null}::text IS NULL OR c.invite_id=${deps?.inviteId ?? null})
          AND NOT EXISTS (SELECT 1 FROM billing_automatic_seat_changes prior
            WHERE prior.seat_subscription_id=c.seat_subscription_id AND prior.id<c.id AND prior.completed_at IS NULL)
        ORDER BY c.next_attempt_at,c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED
      ) UPDATE billing_automatic_seat_changes c SET
        first_attempt_at=COALESCE(c.first_attempt_at,${now}),next_attempt_at=${new Date(now.getTime() + 300_000)}
        FROM candidate WHERE candidate.id=c.id RETURNING c.id`;
    if (!claim) break;
    const row = await prisma.billingAutomaticSeatChange.findUniqueOrThrow({ where: { id: claim.id },
      include: { seatSubscription: { include: { stripeSubscription: { include: { customer: true } } } } } });
    const sub = row.seatSubscription.stripeSubscription;
    const price = await prisma.billingStripeTariffPrice.findUnique({ where: {
      accountId_tariffId: { accountId: account.id, tariffId: row.seatSubscription.tariffId },
    }, select: { stripeMonthlyPriceId: true } });
    if (!row.firstAttemptAt || !sub?.stripeMonthlyItemId || !sub.customer.stripeCustomerId || !price?.stripeMonthlyPriceId) {
      throw new Error('STRIPE_SEAT_SOURCE_UNBOUND');
    }
    const where = { id: row.id, attemptVersion: row.attemptVersion, nextAttemptAt: row.nextAttemptAt, completedAt: null };
    try {
      const result = await collectAnniversarySeat({ ...row, firstAttemptAt: row.firstAttemptAt,
        account: account.stripeAccountId, livemode: account.livemode, checkoutId: sub.checkoutId,
        subscriptionId: sub.stripeSubscriptionId, customerId: sub.customer.stripeCustomerId,
        itemId: sub.stripeMonthlyItemId, priceId: price.stripeMonthlyPriceId, unitAmount: row.seatSubscription.unitAmountMinor,
        currency: row.seatSubscription.currency }, runtime.client, now);
      switch (result.status) {
        case 'complete':
          await prisma.billingAutomaticSeatChange.updateMany({ where, data: {
            completedAt: now, stripeInvoiceId: result.invoice, failureCode: null } });
          break;
        case 'retry-void':
          await prisma.billingAutomaticSeatChange.updateMany({ where, data: {
            firstAttemptAt: null, attemptVersion: { increment: 1 }, stripeInvoiceId: null,
            failureCode: 'PREVIOUS_INVOICE_VOID', nextAttemptAt: new Date(now.getTime() + 60_000) } });
          break;
        default:
          await prisma.billingAutomaticSeatChange.updateMany({ where, data: {
            ...(result.status === 'pending' ? { stripeInvoiceId: result.invoice } : {}),
            failureCode: result.reason, nextAttemptAt: new Date(now.getTime() + 60_000) } });
      }
    } catch {
      await prisma.billingAutomaticSeatChange.updateMany({ where, data: {
        failureCode: 'PROVIDER_RETRY', nextAttemptAt: new Date(now.getTime() + 30_000) } });
    }
  }
  return processed;
}

export function startAnniversarySeatScheduler(params: {
  log: { error: (details: object, message: string) => void }; runCycle?: typeof runAnniversarySeatCycle;
}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await (params.runCycle ?? runAnniversarySeatCycle)(); }
    catch { params.log.error({}, 'Automatic seat collection cycle failed'); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => void run(), 5_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
