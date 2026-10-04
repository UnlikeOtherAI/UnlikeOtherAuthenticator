import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyEvent } = vi.hoisted(() => ({ applyEvent: vi.fn() }));

vi.mock('../../src/services/billing-stripe-webhook-event.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/services/billing-stripe-webhook-event.service.js')
    >();
  return { ...actual, applyTrustedCreditFundingStripeEvent: applyEvent };
});

import { recoverCreditAutoTopUpEvents } from '../../src/services/billing-credit-auto-top-up-event-recovery.service.js';

const account = {
  id: 'stripe_account_1',
  stripeAccountId: 'acct_1',
  livemode: false,
};
const now = new Date('2026-10-04T12:00:00.000Z');
const candidate = {
  attemptId: 'attempt_1',
  creditAccountId: 'credit_1',
  stripePaymentIntentId: 'pi_1',
  createdAt: new Date('2026-10-03T12:00:00.000Z'),
};

function event(
  id: string,
  type = 'payment_intent.succeeded',
  overrides: Record<string, unknown> = {},
): Stripe.Event {
  return {
    id,
    type,
    api_version: '2026-06-24.dahlia',
    account: account.stripeAccountId,
    livemode: false,
    created: Math.floor(now.getTime() / 1000),
    data: {
      object: {
        id: candidate.stripePaymentIntentId,
        status: 'succeeded',
        metadata: { uoa_credit_auto_top_up_attempt_id: candidate.attemptId },
      },
    },
    ...overrides,
  } as Stripe.Event;
}

function stripeWithPages(
  list: ReturnType<typeof vi.fn>,
): Pick<Stripe, 'events'> & Record<string, unknown> {
  return { events: { list } };
}

describe('automatic top-up original Stripe event recovery', () => {
  beforeEach(() => {
    applyEvent.mockReset().mockResolvedValue({ duplicate: false, applied: true });
  });

  it('applies only the original matching PaymentIntent event with the bounded window', async () => {
    const matching = event('evt_original');
    const unrelated = event('evt_unrelated', 'payment_intent.succeeded', {
      data: { object: { id: 'pi_someone_else', status: 'succeeded' } },
    });
    const list = vi.fn().mockResolvedValue({ data: [unrelated, matching], has_more: false });
    const stripe = stripeWithPages(list);

    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [candidate],
      stripe: stripe as never,
      prisma: {} as never,
    });

    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({
      types: [
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.processing',
        'payment_intent.requires_action',
        'payment_intent.canceled',
      ],
      created: {
        gte: Math.floor((candidate.createdAt.getTime() - 5 * 60_000) / 1000),
        lte: Math.floor(now.getTime() / 1000),
      },
      limit: 100,
    });
    expect(applyEvent).toHaveBeenCalledOnce();
    expect(applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: matching, expectedPaymentIntentId: 'pi_1' }),
    );
    expect(result.recoveredPaymentIntentIds).toEqual(new Set(['pi_1']));
  });

  it('processes original events oldest first when payment_failed arrived before payment_succeeded', async () => {
    const oldFailure = event('evt_old_failure', 'payment_intent.payment_failed', {
      created: Math.floor(new Date('2026-10-03T13:00:00.000Z').getTime() / 1000),
    });
    const laterSuccess = event('evt_later_success', 'payment_intent.succeeded', {
      created: Math.floor(new Date('2026-10-03T14:00:00.000Z').getTime() / 1000),
    });
    const list = vi.fn().mockResolvedValue({ data: [laterSuccess, oldFailure], has_more: false });
    applyEvent.mockImplementation(async ({ event: original }: { event: Stripe.Event }) => ({
      duplicate: false,
      applied: original.type === 'payment_intent.succeeded',
    }));

    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [candidate],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(applyEvent.mock.calls.map(([input]) => input.event.type)).toEqual([
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
    ]);
    expect(result.recoveredPaymentIntentIds).toEqual(new Set(['pi_1']));
  });

  it('keeps the attempt unresolved when no matching original event exists', async () => {
    const list = vi.fn().mockResolvedValue({ data: [], has_more: false });
    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [candidate],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(result.diagnostics.get('attempt_1')).toBe('event_not_found');
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('does not scan or apply events for an attempt beyond Stripe retention', async () => {
    const list = vi.fn();
    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [{ ...candidate, createdAt: new Date(now.getTime() - 31 * 24 * 60 * 60_000) }],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(list).not.toHaveBeenCalled();
    expect(result.diagnostics.get('attempt_1')).toBe('event_window_expired');
  });

  it('keeps the whole recovery batch unresolved when the five-page bound is incomplete', async () => {
    let page = 0;
    const list = vi.fn().mockImplementation(async () => {
      page += 1;
      return { data: [event(`evt_page_${page}`)], has_more: true };
    });
    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [candidate],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(list).toHaveBeenCalledTimes(5);
    expect(result.diagnostics.get('attempt_1')).toBe('event_scan_incomplete');
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('rejects an original Event from another account or mode without applying it', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [event('evt_wrong_account', 'payment_intent.succeeded', { account: 'acct_other' })],
      has_more: false,
    });
    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [candidate],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(result.diagnostics.get('attempt_1')).toBe('event_context_invalid');
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('rejects an original Event with an unsupported API version before applying it', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [
        event('evt_wrong_version', 'payment_intent.succeeded', { api_version: '2026-06-30.basil' }),
      ],
      has_more: false,
    });
    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [candidate],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(result.diagnostics.get('attempt_1')).toBe('event_context_invalid');
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('recovers an unbound attempt only from an original Event carrying its exact attempt metadata', async () => {
    const unbound = { ...candidate, stripePaymentIntentId: null };
    const original = event('evt_lost_response', 'payment_intent.succeeded', {
      data: {
        object: {
          id: 'pi_from_original_event',
          status: 'succeeded',
          metadata: { uoa_credit_auto_top_up_attempt_id: candidate.attemptId },
        },
      },
    });
    const unrelated = event('evt_other_attempt', 'payment_intent.succeeded', {
      data: {
        object: {
          id: 'pi_other',
          status: 'succeeded',
          metadata: { uoa_credit_auto_top_up_attempt_id: 'attempt_other' },
        },
      },
    });
    const list = vi.fn().mockResolvedValue({ data: [unrelated, original], has_more: false });
    const result = await recoverCreditAutoTopUpEvents({
      account,
      now,
      candidates: [unbound],
      stripe: stripeWithPages(list) as never,
      prisma: {} as never,
    });

    expect(applyEvent).toHaveBeenCalledOnce();
    expect(applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: original, expectedPaymentIntentId: 'pi_from_original_event' }),
    );
    expect(result.recoveredAttemptPaymentIntents).toEqual(
      new Map([[candidate.attemptId, 'pi_from_original_event']]),
    );
  });
});
