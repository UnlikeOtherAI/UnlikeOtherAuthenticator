import {
  BillingCreditPaymentAdjustmentKind,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { paymentBinding } from './billing-credit-funding-binding.service.js';
import type {
  CreditFundingWebhookClient,
  CreditPaymentBinding,
  PreparedCreditFundingWebhook,
} from './billing-credit-funding-webhook.types.js';
import {
  exactMinor,
  requireUsd,
} from './billing-credit-funding-webhook-validation.service.js';

function disputePrincipalMovement(dispute: Stripe.Dispute, reinstated: boolean): number {
  const movement = dispute.balance_transactions.reduce((total, transaction) => {
    const relevant = reinstated ? transaction.amount > 0 : transaction.amount < 0;
    if (!relevant) return total;
    const absolute = Math.abs(transaction.amount);
    if (transaction.currency.toLowerCase() === dispute.currency.toLowerCase()) {
      return total + absolute;
    }
    if (!transaction.exchange_rate || transaction.exchange_rate <= 0) {
      throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_DISPUTE_FX_PROOF_MISSING');
    }
    return total + Math.round(absolute / transaction.exchange_rate);
  }, 0);
  const principal = Math.min(movement, dispute.amount);
  if (!Number.isSafeInteger(principal) || principal <= 0) {
    throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_DISPUTE_MOVEMENT_PENDING');
  }
  return principal;
}

function disputeProof(dispute: Stripe.Dispute): string {
  return dispute.balance_transactions
    .map(
      (transaction) =>
        `${transaction.id}:${transaction.amount}:${transaction.currency}:${transaction.exchange_rate ?? 'none'}`,
    )
    .sort()
    .join('|');
}

async function resolveStoredPaymentBinding(
  intent: Stripe.PaymentIntent,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<CreditPaymentBinding | null> {
  const [checkout, attempt] = await Promise.all([
    prisma.billingCreditTopUpCheckout.findFirst({
      where: {
        accountId: account.id,
        stripePaymentIntentId: intent.id,
        status: 'COMPLETE',
      },
      include: { customer: true },
    }),
    prisma.billingCreditAutoTopUpAttempt.findFirst({
      where: {
        accountId: account.id,
        stripePaymentIntentId: intent.id,
        status: 'SUCCEEDED',
      },
      include: {
        consentRevision: true,
        creditAccount: { include: { customer: true } },
      },
    }),
  ]);
  if (checkout && attempt) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_BINDING_AMBIGUOUS');
  }
  const customerId = stripeExternalId(intent.customer);
  const paymentMethodId = stripeExternalId(intent.payment_method);
  if (checkout) {
    if (
      checkout.customer.stripeCustomerId !== customerId ||
      checkout.paymentAmountMinor !== exactMinor(intent.amount_received) ||
      checkout.currency !== requireUsd(intent.currency)
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_TOP_UP_BINDING_INVALID');
    }
    return { localId: checkout.id, localType: 'top_up' };
  }
  if (attempt) {
    if (
      attempt.creditAccount.customer.stripeCustomerId !== customerId ||
      attempt.paymentAmountMinor !== exactMinor(intent.amount_received) ||
      attempt.consentRevision.stripePaymentMethodId !== paymentMethodId ||
      requireUsd(intent.currency) !== 'USD'
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
    }
    return { localId: attempt.id, localType: 'automatic_top_up' };
  }
  return null;
}

export async function preparePaymentAdjustmentWebhook(
  event: Stripe.Event,
  stripe: CreditFundingWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedCreditFundingWebhook | null> {
  let kind: BillingCreditPaymentAdjustmentKind;
  let objectId: string;
  let paymentIntentId: string | null;
  let chargeId: string | null;
  let amount: number;
  let currency: string;
  let objectStatus: string | null = null;
  if (
    event.type === 'refund.created' ||
    event.type === 'refund.updated' ||
    event.type === 'refund.failed'
  ) {
    const payload = event.data.object as Stripe.Refund;
    const refund = await stripe.refunds.retrieve(payload.id);
    objectId = refund.id;
    paymentIntentId = stripeExternalId(refund.payment_intent);
    chargeId = stripeExternalId(refund.charge);
    amount = refund.amount;
    currency = refund.currency;
    objectStatus = refund.status;
    if (
      payload.amount !== refund.amount ||
      payload.currency !== refund.currency ||
      stripeExternalId(payload.payment_intent) !== paymentIntentId ||
      stripeExternalId(payload.charge) !== chargeId
    ) {
      throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_ADJUSTMENT_STATE_DRIFT');
    }
    if (payload.status !== refund.status) return null;
    if (['pending', 'requires_action'].includes(refund.status ?? '')) return null;
    if (!refund.status || !['succeeded', 'failed', 'canceled'].includes(refund.status)) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_REFUND_STATUS_INVALID');
    }
    kind =
      refund.status === 'succeeded'
        ? BillingCreditPaymentAdjustmentKind.REFUND
        : BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL;
  } else if (
    event.type === 'charge.dispute.funds_withdrawn' ||
    event.type === 'charge.dispute.funds_reinstated'
  ) {
    const payload = event.data.object as Stripe.Dispute;
    const dispute = await stripe.disputes.retrieve(payload.id);
    assertStripeObjectLivemode(dispute, account.livemode);
    const reinstated = event.type === 'charge.dispute.funds_reinstated';
    kind = reinstated
      ? BillingCreditPaymentAdjustmentKind.DISPUTE_REVERSAL
      : BillingCreditPaymentAdjustmentKind.DISPUTE;
    objectId = dispute.id;
    paymentIntentId = stripeExternalId(dispute.payment_intent);
    chargeId = stripeExternalId(dispute.charge);
    amount = disputePrincipalMovement(dispute, reinstated);
    currency = dispute.currency;
    objectStatus = dispute.status;
    if (
      payload.amount !== dispute.amount ||
      payload.currency !== dispute.currency ||
      stripeExternalId(payload.payment_intent) !== paymentIntentId ||
      stripeExternalId(payload.charge) !== chargeId
    ) {
      throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_ADJUSTMENT_STATE_DRIFT');
    }
    if (disputeProof(payload) !== disputeProof(dispute)) return null;
  } else {
    return null;
  }
  if (!paymentIntentId) return null;
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  assertStripeObjectLivemode(intent, account.livemode);
  const binding = await resolveStoredPaymentBinding(intent, account, prisma);
  if (!binding) {
    if (paymentBinding(intent.metadata)) {
      throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_PAYMENT_PROJECTION_PENDING');
    }
    return null;
  }
  if (!chargeId || amount <= 0 || stripeExternalId(intent.latest_charge) !== chargeId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_ADJUSTMENT_BINDING_INVALID');
  }
  const occurredAt = new Date(event.created * 1000);
  const amountMinor = exactMinor(amount);
  const usd = requireUsd(currency);
  return {
    event: {
      kind: 'payment_adjustment',
      ...binding,
      adjustmentKind: kind,
      stripeObjectId: objectId,
      paymentIntent: intent,
      paymentIntentId,
      chargeId,
      amountMinor,
      currency: usd,
      occurredAt,
    },
    eventFields: {
      stripeObjectId: objectId,
      stripeObjectStatus: objectStatus,
      stripeCustomerId: stripeExternalId(intent.customer),
      stripePaymentIntentId: paymentIntentId,
      stripeChargeId: chargeId,
      amountMinor,
      currency: usd,
      stripeCreatedAt: occurredAt,
    },
  };
}
