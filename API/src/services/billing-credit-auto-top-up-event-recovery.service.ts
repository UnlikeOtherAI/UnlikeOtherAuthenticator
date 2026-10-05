import type Stripe from 'stripe';

import type { PrismaClient } from '@prisma/client';

import {
  applyTrustedCreditFundingStripeEvent,
  assertStripeEventAccount,
  assertStripeEventApiVersion,
} from './billing-stripe-webhook-event.service.js';
import type { CreditAutoTopUpWebhookCandidate } from './billing-credit-auto-top-up-attempt.service.js';
import type { CreditFundingWebhookClient } from './billing-credit-funding-webhook.types.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';

const STRIPE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EVENT_CLOCK_ALLOWANCE_MS = 5 * 60 * 1000;
const EVENT_PAGE_SIZE = 100;
const EVENT_MAX_PAGES = 5;
const AUTO_TOP_UP_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.canceled',
];

export type CreditAutoTopUpEventRecoveryDiagnostic =
  | 'event_not_found'
  | 'event_window_expired'
  | 'event_scan_incomplete'
  | 'event_scan_failed'
  | 'event_context_invalid'
  | 'event_recovery_failed'
  | 'event_applied_unresolved'
  | 'duplicate_event';

export type CreditAutoTopUpEventRecoveryResult = {
  recoveredPaymentIntentIds: Set<string>;
  recoveredAttemptPaymentIntents: Map<string, string>;
  diagnostics: Map<string, CreditAutoTopUpEventRecoveryDiagnostic>;
};

type RecoveryStripeClient = Pick<Stripe, 'events'> & CreditFundingWebhookClient;

function eventPaymentIntentId(event: Stripe.Event): string | null {
  const object = event.data.object as { id?: unknown };
  return typeof object.id === 'string' ? object.id : null;
}

function eventAttemptId(event: Stripe.Event): string | null {
  const object = event.data.object as { metadata?: Record<string, unknown> | null };
  const id = object.metadata?.uoa_credit_auto_top_up_attempt_id;
  return typeof id === 'string' ? id : null;
}

export async function recoverCreditAutoTopUpEvents(params: {
  account: StripeAccountContext;
  now: Date;
  candidates: CreditAutoTopUpWebhookCandidate[];
  stripe: RecoveryStripeClient;
  prisma: PrismaClient;
}): Promise<CreditAutoTopUpEventRecoveryResult> {
  const { account, candidates, now, prisma, stripe } = params;
  const diagnostics = new Map<string, CreditAutoTopUpEventRecoveryDiagnostic>();
  const recoveredPaymentIntentIds = new Set<string>();
  const recoveredAttemptPaymentIntents = new Map<string, string>();
  if (candidates.length === 0) return { recoveredPaymentIntentIds, recoveredAttemptPaymentIntents, diagnostics };

  const cutoff = now.getTime() - STRIPE_EVENT_RETENTION_MS;
  const recent = candidates.filter((candidate) => {
    if (candidate.createdAt.getTime() < cutoff) {
      diagnostics.set(candidate.attemptId, 'event_window_expired');
      return false;
    }
    return true;
  });
  if (recent.length === 0) return { recoveredPaymentIntentIds, recoveredAttemptPaymentIntents, diagnostics };

  const oldestCandidate = Math.min(...recent.map((candidate) => candidate.createdAt.getTime()));
  const createdGte = Math.max(
    cutoff,
    Math.floor((oldestCandidate - EVENT_CLOCK_ALLOWANCE_MS) / 1000) * 1000,
  );
  const createdLte = now.getTime();
  const paymentIntentIds = new Set(
    recent.flatMap((candidate) => (candidate.stripePaymentIntentId ? [candidate.stripePaymentIntentId] : [])),
  );
  const attemptIds = new Set(recent.map((candidate) => candidate.attemptId));
  const events: Stripe.Event[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;
  try {
    for (let pageNumber = 0; pageNumber < EVENT_MAX_PAGES; pageNumber += 1) {
      const page = await stripe.events.list({
        types: AUTO_TOP_UP_EVENT_TYPES,
        created: {
          gte: Math.floor(createdGte / 1000),
          lte: Math.floor(createdLte / 1000),
        },
        limit: EVENT_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const event of page.data) {
        if (
          paymentIntentIds.has(eventPaymentIntentId(event) ?? '') ||
          attemptIds.has(eventAttemptId(event) ?? '')
        ) {
          events.push(event);
        }
      }
      hasMore = page.has_more;
      if (!hasMore) break;
      const lastId = page.data.at(-1)?.id;
      if (!lastId || lastId === startingAfter) break;
      startingAfter = lastId;
    }
  } catch {
    for (const candidate of recent) {
      diagnostics.set(candidate.attemptId, 'event_scan_failed');
    }
    return { recoveredPaymentIntentIds, recoveredAttemptPaymentIntents, diagnostics };
  }
  if (hasMore) {
    for (const candidate of recent) {
      diagnostics.set(candidate.attemptId, 'event_scan_incomplete');
    }
    return { recoveredPaymentIntentIds, recoveredAttemptPaymentIntents, diagnostics };
  }

  const matching = events
    .filter((event) => AUTO_TOP_UP_EVENT_TYPES.includes(event.type))
    .sort((left, right) => left.created - right.created || left.id.localeCompare(right.id));
  if (matching.length > 0) {
    try {
      for (const event of matching) {
        assertStripeEventApiVersion(event);
        assertStripeEventAccount(event, account);
      }
    } catch {
      for (const candidate of recent) {
        diagnostics.set(candidate.attemptId, 'event_context_invalid');
      }
      return { recoveredPaymentIntentIds, recoveredAttemptPaymentIntents, diagnostics };
    }
  }

  const observed = new Set<string>();
  const observedAttempts = new Set<string>();
  const duplicate = new Set<string>();
  const eventWasApplied = new Map<string, string>();
  for (const event of matching) {
    const paymentIntentId = eventPaymentIntentId(event);
    if (!paymentIntentId) continue;
    const attemptId = eventAttemptId(event);
    if (attemptId) observedAttempts.add(attemptId);
    observed.add(paymentIntentId);
    try {
      const result = await applyTrustedCreditFundingStripeEvent({
        event,
        expectedPaymentIntentId: paymentIntentId,
        stripe,
        account,
        prisma,
      });
      if (result.applied && event.type === 'payment_intent.succeeded') {
        if (attemptId) eventWasApplied.set(attemptId, paymentIntentId);
      }
      if (result.duplicate && attemptId) duplicate.add(attemptId);
    } catch {
      if (attemptId) diagnostics.set(attemptId, 'event_recovery_failed');
    }
  }

  for (const candidate of recent) {
    if (diagnostics.has(candidate.attemptId)) continue;
    const recoveredPaymentIntentId = eventWasApplied.get(candidate.attemptId);
    if (recoveredPaymentIntentId) {
      recoveredPaymentIntentIds.add(recoveredPaymentIntentId);
      recoveredAttemptPaymentIntents.set(candidate.attemptId, recoveredPaymentIntentId);
    } else if (
      candidate.stripePaymentIntentId
        ? !observed.has(candidate.stripePaymentIntentId)
        : !observedAttempts.has(candidate.attemptId)
    ) {
      diagnostics.set(candidate.attemptId, 'event_not_found');
    } else if (duplicate.has(candidate.attemptId)) {
      diagnostics.set(candidate.attemptId, 'duplicate_event');
    } else {
      diagnostics.set(candidate.attemptId, 'event_applied_unresolved');
    }
  }
  return { recoveredPaymentIntentIds, recoveredAttemptPaymentIntents, diagnostics };
}
