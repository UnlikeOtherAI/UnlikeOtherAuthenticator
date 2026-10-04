import {
  BillingCreditPaymentInvoiceSource,
  Prisma,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import type { CreditFundingEvent } from './billing-credit-funding-webhook.types.js';

type AcceptedPayment = Extract<CreditFundingEvent, { kind: 'payment_succeeded' }>;

type Source = {
  kind: 'top_up' | 'automatic_top_up';
  id: string;
  creditEntryId: string;
  creditAccountId: string;
  creditAccountOrgId: string;
  creditAccountTeamId: string | null;
  serviceId: string;
  appKeyId: string;
  attributedUserId: string;
  amountMinor: bigint;
  creditsMicrocredits: bigint;
  currency: string;
  stripeCustomerId: string;
};

// This runs in the same transaction as the accepted payment's credit entry.
// Document generation is retried separately; it must never be the condition for
// giving a customer credits after Stripe has already accepted payment.
export async function recordAcceptedCreditPaymentInvoice(
  tx: Prisma.TransactionClient,
  params: { event: AcceptedPayment; account: StripeAccountContext; source: Source },
): Promise<void> {
  const { event, account, source } = params;
  const intent = event.paymentIntent;
  if (
    intent.status !== 'succeeded' ||
    intent.livemode !== account.livemode ||
    source.id !== event.localId ||
    source.kind !== event.localType ||
    source.amountMinor <= 0n ||
    source.creditsMicrocredits <= 0n ||
    BigInt(intent.amount_received) !== source.amountMinor ||
    intent.currency.toUpperCase() !== source.currency ||
    stripeExternalId(intent.customer) !== source.stripeCustomerId ||
    stripeExternalId(intent.latest_charge) !== event.chargeId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_INVOICE_SOURCE_INVALID');
  }
  const existing = await tx.billingCreditPaymentInvoice.findUnique({
    where: {
      accountId_livemode_stripePaymentIntentId: {
        accountId: account.id,
        livemode: account.livemode,
        stripePaymentIntentId: intent.id,
      },
    },
  });
  if (existing) {
    if (
      existing.creditEntryId === source.creditEntryId &&
      existing.creditAccountId === source.creditAccountId &&
      existing.grossAmountMinor === source.amountMinor &&
      existing.creditsPurchasedMicrocredits === source.creditsMicrocredits &&
      existing.stripeChargeId === event.chargeId
    ) return;
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_INVOICE_REBIND_FORBIDDEN');
  }
  await tx.billingCreditPaymentInvoice.create({
    data: {
      accountId: account.id,
      livemode: account.livemode,
      stripePaymentIntentId: intent.id,
      stripeChargeId: event.chargeId,
      source: source.kind === 'top_up'
        ? BillingCreditPaymentInvoiceSource.MANUAL_TOP_UP
        : BillingCreditPaymentInvoiceSource.AUTO_RECHARGE,
      topUpCheckoutId: source.kind === 'top_up' ? source.id : null,
      autoTopUpAttemptId: source.kind === 'automatic_top_up' ? source.id : null,
      creditEntryId: source.creditEntryId,
      creditAccountId: source.creditAccountId,
      serviceId: source.serviceId,
      appKeyId: source.appKeyId,
      orgId: source.creditAccountOrgId,
      teamId: source.creditAccountTeamId,
      attributedUserId: source.attributedUserId,
      stripeCustomerId: source.stripeCustomerId,
      currency: source.currency,
      grossAmountMinor: source.amountMinor,
      creditsPurchasedMicrocredits: source.creditsMicrocredits,
      // This is Stripe's signed payment-intent.succeeded event time, not the
      // invoice issue time or the time this webhook happens to be processed.
      paidAt: event.occurredAt,
    },
  });
}
