import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';

type MonthlyQuote = Awaited<ReturnType<typeof quoteSubscriptionMonthlyCharge>>;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item)).digest('hex');
}

function quoteDigest(quote: MonthlyQuote): string {
  return sha256({ source: quote.source, billingMonth: quote.billingMonth,
    serviceId: quote.serviceId, tariffId: quote.tariffId,
    orgId: quote.organisationId, teamId: quote.teamId, scope: quote.scope,
    agreementId: quote.agreementId, amountMinor: quote.amountMinor,
    unitAmountMinor: quote.unitAmountMinor, chargeBasis: quote.chargeBasis,
    seatPolicy: quote.seatPolicy, seatChargeTiming: quote.seatChargeTiming,
    commercialEffectiveAt: quote.commercialEffectiveAt,
    commercialEndsAt: quote.commercialEndsAt, evidenceIds: quote.evidenceIds,
    intervals: quote.intervals, capacityRevisions: quote.capacityRevisions });
}

/** Freeze one earned fee before either renewal or closing invoice egress. */
export async function freezeStripeMonthlyChargeSource(quote: MonthlyQuote, params: {
  accountId: string; subscriptionId: string; invoiceId?: string;
  billingMonth: string; periodStartsAt: Date; periodEndsAt: Date; currency: string;
}, prisma: PrismaClient) {
  if (quote.source.kind !== 'stripe' || quote.source.id !== params.subscriptionId ||
    quote.billingMonth !== params.billingMonth || quote.currency !== params.currency ||
    quote.chargeBasis !== 'PER_SEAT' || quote.amountMinor < 0n ||
    quote.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_QUOTE_DRIFT');
  }
  const authorityKey = sha256({ accountId: params.accountId,
    subscriptionId: params.subscriptionId, billingMonth: params.billingMonth });
  const source = await prisma.billingStripeMonthlyCharge.upsert({
    where: { subscriptionId_billingMonth: {
      subscriptionId: params.subscriptionId, billingMonth: params.billingMonth,
    } },
    create: {
      subscriptionId: params.subscriptionId, accountId: params.accountId,
      stripeInvoiceId: params.invoiceId ?? null, allocationKind: params.invoiceId ? 'RENEWAL' : 'CLOSING', billingMonth: params.billingMonth,
      periodStartsAt: params.periodStartsAt, periodEndsAt: params.periodEndsAt,
      amountMinor: quote.amountMinor, currency: params.currency,
      authorityKey, sourceDigest: quoteDigest(quote),
      idempotencyKey: `uoa-monthly-seat-${authorityKey}`,
      state: quote.amountMinor === 0n ? 'NO_CHARGE' : 'PENDING',
    },
    update: {},
  });
  if (source.accountId !== params.accountId ||
    source.amountMinor !== quote.amountMinor ||
    source.currency !== params.currency || source.authorityKey !== authorityKey ||
    source.sourceDigest !== quoteDigest(quote) ||
    source.periodStartsAt.getTime() !== params.periodStartsAt.getTime() ||
    source.periodEndsAt.getTime() !== params.periodEndsAt.getTime()) {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_SOURCE_CHANGED');
  }
  return source;
}
