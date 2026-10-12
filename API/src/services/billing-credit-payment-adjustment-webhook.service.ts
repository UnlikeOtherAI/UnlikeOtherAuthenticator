import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditCheckoutStatus,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  BillingCreditPaymentAdjustmentKind,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AppError } from '../utils/errors.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import type { CreditFundingEvent } from './billing-credit-funding-webhook.types.js';

type AdjustmentEvent = Extract<CreditFundingEvent, { kind: 'payment_adjustment' }>;
type AdjustmentState = {
  kind: BillingCreditPaymentAdjustmentKind;
  stripeObjectId: string;
  amountMinor: bigint;
  amountMicrocredits: bigint;
};

function isReversal(kind: BillingCreditPaymentAdjustmentKind): boolean {
  return (
    kind === BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL ||
    kind === BillingCreditPaymentAdjustmentKind.DISPUTE_REVERSAL
  );
}

function familyKey(kind: BillingCreditPaymentAdjustmentKind, objectId: string): string {
  const family =
    kind === BillingCreditPaymentAdjustmentKind.REFUND ||
    kind === BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL
      ? 'refund'
      : 'dispute';
  return `${family}:${objectId}`;
}

function entryKind(kind: BillingCreditPaymentAdjustmentKind): BillingCreditEntryKind {
  switch (kind) {
    case BillingCreditPaymentAdjustmentKind.REFUND:
      return BillingCreditEntryKind.REFUND;
    case BillingCreditPaymentAdjustmentKind.DISPUTE:
      return BillingCreditEntryKind.DISPUTE;
    case BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL:
      return BillingCreditEntryKind.REFUND_REVERSAL;
    case BillingCreditPaymentAdjustmentKind.DISPUTE_REVERSAL:
      return BillingCreditEntryKind.DISPUTE_REVERSAL;
  }
}

/** The paid entry an adjustment reverses, and what was paid for it in which currency. */
async function resolvePaidEntry(
  tx: Prisma.TransactionClient,
  event: AdjustmentEvent,
  account: StripeAccountContext,
) {
  if (event.localType === 'top_up') {
    const checkout = await tx.billingCreditTopUpCheckout.findUnique({
      where: { id: event.localId },
      include: { creditEntry: true, customer: true },
    });
    if (
      !checkout ||
      checkout.accountId !== account.id ||
      checkout.status !== BillingCreditCheckoutStatus.COMPLETE ||
      checkout.stripePaymentIntentId !== event.paymentIntentId ||
      checkout.customer.stripeCustomerId !== stripeExternalId(event.paymentIntent.customer) ||
      !checkout.creditEntry
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_NOT_FOUND');
    }
    return { entry: checkout.creditEntry, currency: checkout.currency,
      paymentAmountMinor: checkout.paymentAmountMinor };
  }
  const attempt = await tx.billingCreditAutoTopUpAttempt.findUnique({
    where: { id: event.localId },
    include: {
      creditEntry: true,
      consentRevision: true,
      creditAccount: { include: { customer: true } },
    },
  });
  if (
    !attempt ||
    attempt.accountId !== account.id ||
    attempt.status !== BillingCreditAutoTopUpAttemptStatus.SUCCEEDED ||
    attempt.stripePaymentIntentId !== event.paymentIntentId ||
    attempt.creditAccount.customer.stripeCustomerId !==
      stripeExternalId(event.paymentIntent.customer) ||
    attempt.consentRevision.stripePaymentMethodId !==
      stripeExternalId(event.paymentIntent.payment_method) ||
    !attempt.creditEntry
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_NOT_FOUND');
  }
  return { entry: attempt.creditEntry, currency: attempt.currency,
    paymentAmountMinor: attempt.paymentAmountMinor };
}

async function lockPaidEntry(
  tx: Prisma.TransactionClient,
  paidEntryId: string,
): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
    WITH payment_lock AS (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`credit-payment:${paidEntryId}`}, 0)
      )
    )
    SELECT 1::integer AS "locked" FROM payment_lock
  `);
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "billing_credit_entries"
    WHERE "id" = ${paidEntryId}
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_NOT_FOUND');
  }
}

/**
 * The credits an active refunded or disputed principal (money, in the purchase
 * currency) takes back: at the purchase's own terms, in whole credits, never
 * more than it granted. A USD purchase granted 10,000,000 microcredits a cent,
 * so its refunds are unchanged; a refund of what is left of a GBP or EUR lot, in
 * its currency, takes back what is left of it. The database computes the same.
 */
export function creditsForPrincipal(principalMinor: bigint, paid: { amountMinor: bigint;
  microcredits: bigint }): bigint {
  const credits = (principalMinor * paid.microcredits) / (paid.amountMinor * 1_000_000n) * 1_000_000n;
  return credits < paid.microcredits ? credits : paid.microcredits;
}

export function expectedAppliedDelta(
  states: AdjustmentState[],
  event: Pick<AdjustmentEvent, 'adjustmentKind' | 'stripeObjectId' | 'amountMinor'>,
  paid: { amountMinor: bigint; microcredits: bigint },
): bigint {
  const active = new Map<string, bigint>();
  const restored = new Map<string, bigint>();
  let currentlyApplied = 0n;
  for (const state of states) {
    const reversal = isReversal(state.kind);
    const key = familyKey(state.kind, state.stripeObjectId);
    if (reversal) restored.set(key, state.amountMinor);
    else active.set(key, state.amountMinor);
    currentlyApplied += reversal
      ? -state.amountMicrocredits
      : state.amountMicrocredits;
  }
  const eventKey = familyKey(event.adjustmentKind, event.stripeObjectId);
  if (isReversal(event.adjustmentKind)) {
    restored.set(eventKey, event.amountMinor);
  }
  else active.set(eventKey, event.amountMinor);
  let activePrincipalMinor = 0n;
  for (const [key, amount] of active) {
    const restoredAmount = restored.get(key) ?? 0n;
    activePrincipalMinor += amount > restoredAmount ? amount - restoredAmount : 0n;
  }
  const desiredApplied = creditsForPrincipal(activePrincipalMinor, paid);
  const delta = desiredApplied - currentlyApplied;
  if (
    (isReversal(event.adjustmentKind) && delta > 0n) ||
    (!isReversal(event.adjustmentKind) && delta < 0n)
  ) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CREDIT_ADJUSTMENT_STATE_CONFLICT');
  }
  return delta < 0n ? -delta : delta;
}

export async function applyPaymentAdjustment(
  tx: Prisma.TransactionClient,
  event: AdjustmentEvent,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  const paid = await resolvePaidEntry(tx, event, account);
  const paidEntry = paid.entry;
  if (!paidEntry.serviceId || !paidEntry.appKeyId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_NOT_FOUND');
  }
  if (event.currency !== paid.currency) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_ADJUSTMENT_BINDING_INVALID');
  }
  await lockPaidEntry(tx, paidEntry.id);
  const existing = await tx.billingCreditPaymentAdjustment.findUnique({
    where: {
      accountId_kind_stripeObjectId: {
        accountId: account.id,
        kind: event.adjustmentKind,
        stripeObjectId: event.stripeObjectId,
      },
    },
  });
  if (existing) {
    if (
      existing.originalEntryId === paidEntry.id &&
      existing.stripePaymentIntentId === event.paymentIntentId &&
      existing.stripeChargeId === event.chargeId &&
      existing.amountMinor === event.amountMinor &&
      existing.currency === event.currency &&
      existing.livemode === account.livemode
    ) {
      return;
    }
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_ADJUSTMENT_REBIND_FORBIDDEN');
  }
  const states = await tx.billingCreditPaymentAdjustment.findMany({
    where: { originalEntryId: paidEntry.id },
    select: {
      kind: true,
      stripeObjectId: true,
      amountMinor: true,
      amountMicrocredits: true,
    },
  });
  const amountMicrocredits = expectedAppliedDelta(states, event,
    { amountMinor: paid.paymentAmountMinor, microcredits: paidEntry.amountMicrocredits });
  const adjustmentId = randomUUID();
  const creditEntryId = amountMicrocredits > 0n ? randomUUID() : null;
  const idempotencyKey = `stripe:${event.adjustmentKind.toLowerCase()}:${event.stripeObjectId}`;
  await tx.billingCreditPaymentAdjustment.create({
    data: {
      id: adjustmentId,
      accountId: account.id,
      creditAccountId: paidEntry.creditAccountId,
      serviceId: paidEntry.serviceId,
      appKeyId: paidEntry.appKeyId,
      kind: event.adjustmentKind,
      originalEntryId: paidEntry.id,
      webhookEventId,
      stripeObjectId: event.stripeObjectId,
      stripePaymentIntentId: event.paymentIntentId,
      stripeChargeId: event.chargeId,
      amountMinor: event.amountMinor,
      amountMicrocredits,
      currency: event.currency,
      livemode: account.livemode,
      idempotencyKey,
      creditEntryId,
      occurredAt: event.occurredAt,
    },
  });
  if (!creditEntryId) return;
  const reversal = isReversal(event.adjustmentKind);
  const balance = await lockCreditBalance(tx, paidEntry.creditAccountId);
  await tx.billingCreditEntry.create({
    data: {
      id: creditEntryId,
      creditAccountId: paidEntry.creditAccountId,
      serviceId: paidEntry.serviceId,
      appKeyId: paidEntry.appKeyId,
      attributedUserId: paidEntry.attributedUserId,
      direction: reversal
        ? BillingCreditEntryDirection.CREDIT
        : BillingCreditEntryDirection.DEBIT,
      kind: entryKind(event.adjustmentKind),
      amountMicrocredits,
      balanceAfterMicrocredits: reversal
        ? balance + amountMicrocredits
        : balance - amountMicrocredits,
      // Credits stay USD-denominated; the adjustment row keeps the refunded money's currency.
      currency: paidEntry.currency,
      idempotencyKey,
      sourceType: 'credit_payment_adjustment',
      sourceId: adjustmentId,
      reversesEntryId: paidEntry.id,
      occurredAt: event.occurredAt,
    },
  });
}
