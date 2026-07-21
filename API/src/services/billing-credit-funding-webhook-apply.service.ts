import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpConsentSource,
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AppError } from '../utils/errors.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { applyPaymentAdjustment } from './billing-credit-payment-adjustment-webhook.service.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import type {
  CreditFundingEvent,
  PreparedCreditFundingWebhook,
} from './billing-credit-funding-webhook.types.js';

const OPEN_AUTO_TOP_UP_STATES = new Set<BillingCreditAutoTopUpAttemptStatus>([
  BillingCreditAutoTopUpAttemptStatus.PENDING,
  BillingCreditAutoTopUpAttemptStatus.PROCESSING,
  BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION,
  BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
]);

async function applyTopUpSucceeded(
  tx: Prisma.TransactionClient,
  event: Extract<CreditFundingEvent, { kind: 'payment_succeeded' }>,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  const checkout = await tx.billingCreditTopUpCheckout.findUnique({
    where: { id: event.localId },
    include: { customer: true },
  });
  if (!checkout || event.localType !== 'top_up') {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_TOP_UP_BINDING_INVALID');
  }
  if (checkout.status === BillingCreditCheckoutStatus.COMPLETE) {
    if (
      checkout.stripePaymentIntentId === event.paymentIntent.id &&
      checkout.stripeCheckoutSessionId === event.checkoutSessionId
    ) {
      return;
    }
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_TOP_UP_REBIND_FORBIDDEN');
  }
  const intent = event.paymentIntent;
  if (
    checkout.accountId !== account.id ||
    !event.checkoutSessionId ||
    checkout.stripeCheckoutSessionId !== event.checkoutSessionId ||
    stripeExternalId(intent.customer) !== checkout.customer.stripeCustomerId ||
    BigInt(intent.amount_received) !== checkout.paymentAmountMinor ||
    intent.currency.toUpperCase() !== checkout.currency
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_TOP_UP_BINDING_INVALID');
  }
  const entryId = randomUUID();
  const balance = await lockCreditBalance(tx, checkout.creditAccountId);
  await tx.billingCreditEntry.create({
    data: {
      id: entryId,
      creditAccountId: checkout.creditAccountId,
      serviceId: checkout.serviceId,
      appKeyId: checkout.appKeyId,
      attributedUserId: checkout.requestedByUserId,
      direction: BillingCreditEntryDirection.CREDIT,
      kind: BillingCreditEntryKind.TOP_UP,
      amountMicrocredits: checkout.creditsReceivedMicrocredits,
      balanceAfterMicrocredits: balance + checkout.creditsReceivedMicrocredits,
      currency: checkout.currency,
      idempotencyKey: `stripe:payment-intent:${intent.id}`,
      sourceType: 'credit_top_up_checkout',
      sourceId: checkout.id,
      occurredAt: event.occurredAt,
    },
  });
  await tx.billingCreditTopUpCheckout.update({
    where: { id: checkout.id },
    data: {
      status: BillingCreditCheckoutStatus.COMPLETE,
      stripePaymentIntentId: intent.id,
      completionWebhookEventId: webhookEventId,
      completedAt: event.occurredAt,
      creditEntryId: entryId,
    },
  });
}

async function applyAutomaticTopUpSucceeded(
  tx: Prisma.TransactionClient,
  event: Extract<CreditFundingEvent, { kind: 'payment_succeeded' }>,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  const attempt = await tx.billingCreditAutoTopUpAttempt.findUnique({
    where: { id: event.localId },
    include: {
      consentRevision: true,
      creditAccount: { include: { customer: true } },
    },
  });
  if (!attempt || event.localType !== 'automatic_top_up') {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
  if (attempt.status === BillingCreditAutoTopUpAttemptStatus.SUCCEEDED) {
    if (attempt.stripePaymentIntentId === event.paymentIntent.id) return;
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_REBIND_FORBIDDEN');
  }
  const intent = event.paymentIntent;
  if (
    attempt.accountId !== account.id ||
    stripeExternalId(intent.customer) !== attempt.creditAccount.customer.stripeCustomerId ||
    event.paymentMethodId !== attempt.consentRevision.stripePaymentMethodId ||
    BigInt(intent.amount_received) !== attempt.paymentAmountMinor ||
    intent.currency.toUpperCase() !== 'USD' ||
    !OPEN_AUTO_TOP_UP_STATES.has(attempt.status)
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
  const entryId = randomUUID();
  const balance = await lockCreditBalance(tx, attempt.creditAccountId);
  await tx.billingCreditEntry.create({
    data: {
      id: entryId,
      creditAccountId: attempt.creditAccountId,
      serviceId: attempt.serviceId,
      appKeyId: attempt.appKeyId,
      attributedUserId: attempt.attributedUserId,
      direction: BillingCreditEntryDirection.CREDIT,
      kind: BillingCreditEntryKind.AUTOMATIC_TOP_UP,
      amountMicrocredits: attempt.creditsReceivedMicrocredits,
      balanceAfterMicrocredits: balance + attempt.creditsReceivedMicrocredits,
      currency: 'USD',
      idempotencyKey: `stripe:payment-intent:${intent.id}`,
      sourceType: 'credit_auto_top_up_attempt',
      sourceId: attempt.id,
      occurredAt: event.occurredAt,
    },
  });
  await tx.billingCreditAutoTopUpAttempt.update({
    where: { id: attempt.id },
    data: {
      stripePaymentIntentId: intent.id,
      successWebhookEventId: webhookEventId,
      status: BillingCreditAutoTopUpAttemptStatus.SUCCEEDED,
      creditEntryId: entryId,
      resolvedAt: event.occurredAt,
    },
  });
}

async function applyPaymentFailure(
  tx: Prisma.TransactionClient,
  event: Extract<CreditFundingEvent, { kind: 'payment_failed' }>,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  if (event.localType === 'top_up') return;
  const attempt = await tx.billingCreditAutoTopUpAttempt.findUnique({
    where: { id: event.localId },
    include: {
      consentRevision: true,
      creditAccount: { include: { customer: true } },
    },
  });
  if (!attempt || attempt.accountId !== account.id) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
  if (
    stripeExternalId(event.paymentIntent.customer) !==
      attempt.creditAccount.customer.stripeCustomerId ||
    (event.paymentMethodId &&
      event.paymentMethodId !== attempt.consentRevision.stripePaymentMethodId) ||
    (attempt.stripePaymentIntentId && attempt.stripePaymentIntentId !== event.paymentIntent.id)
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
  if (attempt.status === BillingCreditAutoTopUpAttemptStatus.SUCCEEDED) {
    return;
  }
  if (attempt.status === BillingCreditAutoTopUpAttemptStatus.CANCELED) {
    return;
  }
  if (
    attempt.status === BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW &&
    attempt.stripePaymentIntentId === event.paymentIntent.id &&
    attempt.stateWebhookEventId === webhookEventId
  ) {
    return;
  }
  if (attempt.status === BillingCreditAutoTopUpAttemptStatus.FAILED) {
    if (attempt.stripePaymentIntentId === event.paymentIntent.id) return;
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_REBIND_FORBIDDEN');
  }
  const terminalFailure = ['requires_payment_method', 'requires_confirmation'].includes(
    event.paymentIntent.status,
  );
  await tx.billingCreditAutoTopUpAttempt.update({
    where: { id: attempt.id },
    data: {
      stripePaymentIntentId: event.paymentIntent.id,
      stateWebhookEventId: webhookEventId,
      status: terminalFailure
        ? BillingCreditAutoTopUpAttemptStatus.FAILED
        : BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
      failureCode: event.paymentIntent.last_payment_error?.code ?? 'payment_failed',
      resolvedAt: terminalFailure ? event.occurredAt : null,
    },
  });
  await tx.billingCreditAccount.updateMany({
    where: {
      id: attempt.creditAccountId,
      autoTopUpState: { not: BillingCreditAutoTopUpState.DISABLED },
    },
    data: { autoTopUpState: BillingCreditAutoTopUpState.NEEDS_REVIEW },
  });
}

async function applyPaymentStateChange(
  tx: Prisma.TransactionClient,
  event: Extract<CreditFundingEvent, { kind: 'payment_state_changed' }>,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  if (event.localType === 'top_up') return;
  const attempt = await tx.billingCreditAutoTopUpAttempt.findUnique({
    where: { id: event.localId },
    include: {
      consentRevision: true,
      creditAccount: { include: { customer: true } },
    },
  });
  if (
    !attempt ||
    attempt.accountId !== account.id ||
    stripeExternalId(event.paymentIntent.customer) !==
      attempt.creditAccount.customer.stripeCustomerId ||
    (event.paymentMethodId &&
      event.paymentMethodId !== attempt.consentRevision.stripePaymentMethodId) ||
    (attempt.stripePaymentIntentId && attempt.stripePaymentIntentId !== event.paymentIntent.id) ||
    BigInt(event.paymentIntent.amount) !== attempt.paymentAmountMinor ||
    event.paymentIntent.currency.toUpperCase() !== 'USD'
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
  if (attempt.status === BillingCreditAutoTopUpAttemptStatus.SUCCEEDED) return;
  if (
    attempt.status === BillingCreditAutoTopUpAttemptStatus.CANCELED &&
    attempt.stripePaymentIntentId === event.paymentIntent.id
  ) {
    return;
  }
  if (!OPEN_AUTO_TOP_UP_STATES.has(attempt.status)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CREDIT_AUTO_TOP_UP_STATE_CONFLICT');
  }
  const nextStatus =
    event.state === 'processing'
      ? BillingCreditAutoTopUpAttemptStatus.PROCESSING
      : event.state === 'requires_action'
        ? BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION
        : BillingCreditAutoTopUpAttemptStatus.CANCELED;
  await tx.billingCreditAutoTopUpAttempt.update({
    where: { id: attempt.id },
    data: {
      stripePaymentIntentId: event.paymentIntent.id,
      stateWebhookEventId: webhookEventId,
      status: nextStatus,
      failureCode:
        event.state === 'canceled'
          ? (event.paymentIntent.cancellation_reason ?? 'payment_canceled')
          : null,
      resolvedAt: event.state === 'canceled' ? event.occurredAt : null,
    },
  });
  await tx.billingCreditAccount.updateMany({
    where: {
      id: attempt.creditAccountId,
      autoTopUpState: { not: BillingCreditAutoTopUpState.DISABLED },
    },
    data: {
      autoTopUpState:
        event.state === 'requires_action'
          ? BillingCreditAutoTopUpState.REQUIRES_ACTION
          : event.state === 'processing'
            ? BillingCreditAutoTopUpState.PAUSED
            : BillingCreditAutoTopUpState.NEEDS_REVIEW,
    },
  });
}

async function applySetupSucceeded(
  tx: Prisma.TransactionClient,
  event: Extract<CreditFundingEvent, { kind: 'setup_succeeded' }>,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  const checkout = await tx.billingCreditSetupCheckout.findUnique({
    where: { id: event.localId },
    include: { creditAccount: true, customer: true },
  });
  if (!checkout) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_SETUP_BINDING_INVALID');
  }
  if (checkout.status === BillingCreditCheckoutStatus.COMPLETE) {
    if (
      checkout.stripeSetupIntentId === event.setupIntent.id &&
      checkout.stripePaymentMethodId === event.paymentMethodId
    ) {
      return;
    }
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_SETUP_REBIND_FORBIDDEN');
  }
  if (
    checkout.accountId !== account.id ||
    checkout.stripeCheckoutSessionId !== event.checkoutSessionId ||
    stripeExternalId(event.setupIntent.customer) !== checkout.customer.stripeCustomerId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_SETUP_BINDING_INVALID');
  }
  const locked = await tx.$queryRaw<
    Array<{ autoTopUpGeneration: number; autoTopUpConsentRevisionId: string | null }>
  >(Prisma.sql`
    SELECT
      "auto_top_up_generation" AS "autoTopUpGeneration",
      "auto_top_up_consent_revision_id" AS "autoTopUpConsentRevisionId"
    FROM "billing_credit_accounts"
    WHERE "id" = ${checkout.creditAccountId}
    FOR UPDATE
  `);
  const predecessor = locked[0];
  if (!predecessor) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_SETUP_BINDING_INVALID');
  }
  if (
    predecessor.autoTopUpGeneration !== checkout.expectedGeneration ||
    predecessor.autoTopUpConsentRevisionId !== checkout.expectedConsentRevisionId
  ) {
    await tx.billingCreditSetupCheckout.updateMany({
      where: {
        id: checkout.id,
        status: {
          in: [
            BillingCreditCheckoutStatus.CREATING,
            BillingCreditCheckoutStatus.OPEN,
            BillingCreditCheckoutStatus.NEEDS_REVIEW,
          ],
        },
      },
      data: { status: BillingCreditCheckoutStatus.ABANDONED },
    });
    return;
  }
  await tx.billingCreditSetupCheckout.update({
    where: { id: checkout.id },
    data: {
      status: BillingCreditCheckoutStatus.COMPLETE,
      stripeSetupIntentId: event.setupIntent.id,
      stripePaymentMethodId: event.paymentMethodId,
      completionWebhookEventId: webhookEventId,
      completedAt: event.occurredAt,
    },
  });
  const revision = await tx.billingCreditAutoTopUpConsentRevision.create({
    data: {
      accountId: checkout.accountId,
      creditAccountId: checkout.creditAccountId,
      orgId: checkout.creditAccount.orgId,
      teamId: checkout.creditAccount.teamId,
      serviceId: checkout.serviceId,
      appKeyId: checkout.appKeyId,
      policyId: checkout.policyId,
      optionId: checkout.optionId,
      refillOfferId: checkout.refillOfferId,
      setupCheckoutId: checkout.id,
      source: BillingCreditAutoTopUpConsentSource.SETUP_CHECKOUT,
      actorJti: checkout.actorJti,
      consentedByUserId: checkout.requestedByUserId,
      consentVersion: checkout.consentVersion,
      thresholdMicrocredits: checkout.thresholdMicrocredits,
      refillCreditsMicrocredits: checkout.refillCreditsMicrocredits,
      refillPaymentAmountMinor: checkout.refillPaymentAmountMinor,
      monthlyChargeCapMinor: checkout.monthlyChargeCapMinor,
      stripePaymentMethodId: event.paymentMethodId,
      paymentMethodSummary: event.paymentMethodSummary,
      consentedAt: event.occurredAt,
    },
  });
  const activated = await tx.billingCreditAccount.updateMany({
    where: {
      id: checkout.creditAccountId,
      autoTopUpGeneration: checkout.expectedGeneration,
      autoTopUpConsentRevisionId: checkout.expectedConsentRevisionId,
    },
    data: {
      autoTopUpGeneration: { increment: 1 },
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpPolicyId: checkout.policyId,
      autoTopUpServiceId: checkout.serviceId,
      autoTopUpAppKeyId: checkout.appKeyId,
      autoTopUpConsentRevisionId: revision.id,
      autoTopUpOptionId: checkout.optionId,
      autoTopUpThresholdMicrocredits: checkout.thresholdMicrocredits,
      autoTopUpRefillOfferId: checkout.refillOfferId,
      autoTopUpMonthlyChargeCapMinor: checkout.monthlyChargeCapMinor,
      autoTopUpConsentVersion: checkout.consentVersion,
      autoTopUpConsentedAt: event.occurredAt,
      autoTopUpConsentedByUserId: checkout.requestedByUserId,
      stripePaymentMethodId: event.paymentMethodId,
      paymentMethodSummary: event.paymentMethodSummary,
    },
  });
  if (activated.count !== 1) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SETUP_PREDECESSOR_CHANGED');
  }
}

async function applyCheckoutExpiry(
  tx: Prisma.TransactionClient,
  event: Extract<CreditFundingEvent, { kind: 'checkout_expired' }>,
  account: StripeAccountContext,
): Promise<void> {
  const existing =
    event.localType === 'top_up'
      ? await tx.billingCreditTopUpCheckout.findUnique({ where: { id: event.localId } })
      : await tx.billingCreditSetupCheckout.findUnique({ where: { id: event.localId } });
  if (
    !existing ||
    existing.accountId !== account.id ||
    existing.stripeCheckoutSessionId !== event.checkoutSessionId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
  if (
    existing.status === BillingCreditCheckoutStatus.COMPLETE ||
    existing.status === BillingCreditCheckoutStatus.EXPIRED ||
    existing.status === BillingCreditCheckoutStatus.ABANDONED
  ) {
    return;
  }
  const where = {
    id: event.localId,
    stripeCheckoutSessionId: event.checkoutSessionId,
    status: {
      in: [
        BillingCreditCheckoutStatus.CREATING,
        BillingCreditCheckoutStatus.OPEN,
        BillingCreditCheckoutStatus.NEEDS_REVIEW,
      ],
    },
  };
  const data = { status: BillingCreditCheckoutStatus.EXPIRED, expiresAt: event.expiresAt };
  const result =
    event.localType === 'top_up'
      ? await tx.billingCreditTopUpCheckout.updateMany({ where, data })
      : await tx.billingCreditSetupCheckout.updateMany({ where, data });
  if (result.count !== 1) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CREDIT_CHECKOUT_STATE_CONFLICT');
  }
}

export async function applyCreditFundingWebhook(
  tx: Prisma.TransactionClient,
  prepared: PreparedCreditFundingWebhook,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  const event = prepared.event;
  if (event.kind === 'payment_succeeded') {
    if (event.localType === 'top_up') {
      await applyTopUpSucceeded(tx, event, webhookEventId, account);
    } else {
      await applyAutomaticTopUpSucceeded(tx, event, webhookEventId, account);
    }
  } else if (event.kind === 'payment_failed') {
    await applyPaymentFailure(tx, event, webhookEventId, account);
  } else if (event.kind === 'payment_state_changed') {
    await applyPaymentStateChange(tx, event, webhookEventId, account);
  } else if (event.kind === 'setup_succeeded') {
    await applySetupSucceeded(tx, event, webhookEventId, account);
  } else if (event.kind === 'payment_adjustment') {
    await applyPaymentAdjustment(tx, event, webhookEventId, account);
  } else {
    await applyCheckoutExpiry(tx, event, account);
  }
}
