import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';

type StripeMonthlyClient = Pick<Stripe, 'invoiceItems'>;
type MonthlyQuote = Awaited<ReturnType<typeof quoteSubscriptionMonthlyCharge>>;
type Source = Awaited<ReturnType<PrismaClient['billingStripeMonthlyCharge']['upsert']>>;
const RETRY_KEY_MAX_AGE_MS = 23 * 60 * 60 * 1000;

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

async function remoteItem(
  stripe: StripeMonthlyClient, invoiceId: string, authorityKey: string,
): Promise<Stripe.InvoiceItem | null> {
  let after: string | undefined;
  let matching: Stripe.InvoiceItem | null = null;
  for (let page = 0; page < 3; page += 1) {
    const items = await stripe.invoiceItems.list({ invoice: invoiceId, limit: 100,
      ...(after ? { starting_after: after } : {}) });
    for (const item of items.data) {
      if (item.metadata?.uoa_monthly_charge_key !== authorityKey) continue;
      if (matching) throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_DUPLICATE_REMOTE');
      matching = item;
    }
    if (!items.has_more) return matching;
    after = items.data.at(-1)?.id;
    if (!after || page === 2) {
      throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_INVOICE_ITEMS_UNBOUNDED');
    }
  }
  return matching;
}

function verifyItem(item: Stripe.InvoiceItem, source: Source, params: {
  customerId: string; livemode: boolean;
}): void {
  assertStripeObjectLivemode(item, params.livemode);
  if (item.invoice !== source.stripeInvoiceId ||
    item.customer !== params.customerId ||
    item.amount !== Number(source.amountMinor) ||
    item.currency.toUpperCase() !== source.currency ||
    item.metadata?.uoa_monthly_charge_key !== source.authorityKey ||
    item.period?.start !== Math.floor(source.periodStartsAt.getTime() / 1000) ||
    item.period?.end !== Math.floor(source.periodEndsAt.getTime() / 1000)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_REMOTE_MISMATCH');
  }
}

async function acceptItem(prisma: PrismaClient, source: Source, item: Stripe.InvoiceItem): Promise<void> {
  await prisma.billingStripeMonthlyCharge.update({ where: { id: source.id }, data: {
    state: 'ACCEPTED', stripeInvoiceItemId: item.id, lastErrorCode: null,
  } });
}

/** Add a frozen per-seat arrears fee to this exact DRAFT invoice once. */
export async function collectStripeMonthlyCharge(params: {
  subscriptionId: string;
  accountId: string;
  invoiceId: string;
  customerId: string;
  livemode: boolean;
  billingMonth: string;
  periodStartsAt: Date;
  periodEndsAt: Date;
  currency: string;
  stripeMonthlyItemId: string | null;
  monthlyLineObserved: boolean;
  closingCancellation: boolean;
}, deps: {
  prisma: PrismaClient;
  stripe: StripeMonthlyClient;
  quote?: typeof quoteSubscriptionMonthlyCharge;
  now?: () => Date;
}): Promise<void> {
  const quote = await (deps.quote ?? quoteSubscriptionMonthlyCharge)({
    source: { kind: 'stripe', id: params.subscriptionId },
    billingMonth: params.billingMonth,
  }, { prisma: deps.prisma, now: deps.now });
  if (quote.source.id !== params.subscriptionId ||
    quote.billingMonth !== params.billingMonth || quote.currency !== params.currency) {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_QUOTE_DRIFT');
  }
  // A flat fee is already the subscription's licensed recurring price.
  // Per-seat plans deliberately have no licensed monthly price and collect
  // their frozen closed-month seat quote as an invoice item in arrears.
  if (quote.chargeBasis === 'FLAT') {
    if (!params.stripeMonthlyItemId ||
      (!params.monthlyLineObserved && !params.closingCancellation)) {
      throw new AppError('INTERNAL', 409, 'STRIPE_FLAT_MONTHLY_PRICE_MISSING');
    }
    return;
  }
  if (quote.chargeBasis !== 'PER_SEAT' || params.stripeMonthlyItemId ||
    quote.amountMinor < 0n || quote.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SEAT_MONTHLY_SOURCE_INVALID');
  }
  const authorityKey = sha256({ accountId: params.accountId,
    subscriptionId: params.subscriptionId, billingMonth: params.billingMonth });
  const source = await deps.prisma.billingStripeMonthlyCharge.upsert({
    where: { subscriptionId_billingMonth: {
      subscriptionId: params.subscriptionId, billingMonth: params.billingMonth,
    } },
    create: {
      subscriptionId: params.subscriptionId, accountId: params.accountId,
      stripeInvoiceId: params.invoiceId, billingMonth: params.billingMonth,
      periodStartsAt: params.periodStartsAt, periodEndsAt: params.periodEndsAt,
      amountMinor: quote.amountMinor, currency: params.currency,
      authorityKey, sourceDigest: quoteDigest(quote),
      idempotencyKey: `uoa-monthly-seat-${authorityKey}`,
      state: quote.amountMinor === 0n ? 'NO_CHARGE' : 'PENDING',
    },
    update: {},
  });
  if (source.accountId !== params.accountId ||
    source.stripeInvoiceId !== params.invoiceId || source.amountMinor !== quote.amountMinor ||
    source.currency !== params.currency || source.authorityKey !== authorityKey ||
    source.sourceDigest !== quoteDigest(quote) ||
    source.periodStartsAt.getTime() !== params.periodStartsAt.getTime() ||
    source.periodEndsAt.getTime() !== params.periodEndsAt.getTime()) {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_SOURCE_CHANGED');
  }
  if (source.amountMinor === 0n) {
    if (source.state !== 'NO_CHARGE' || source.stripeInvoiceItemId) {
      throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_ZERO_CHARGE_SOURCE_INVALID');
    }
    return;
  }
  const observed = await remoteItem(deps.stripe, params.invoiceId, authorityKey);
  if (observed) {
    verifyItem(observed, source, params);
    if (source.stripeInvoiceItemId && source.stripeInvoiceItemId !== observed.id) {
      throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_REMOTE_CHANGED');
    }
    await acceptItem(deps.prisma, source, observed);
    return;
  }
  if (source.stripeInvoiceItemId || source.state === 'ACCEPTED') {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_ACCEPTED_ITEM_MISSING');
  }
  const now = deps.now?.() ?? new Date();
  if (source.firstAttemptAt &&
    now.getTime() - source.firstAttemptAt.getTime() >= RETRY_KEY_MAX_AGE_MS) {
    throw new AppError('INTERNAL', 409, 'STRIPE_MONTHLY_CHARGE_RETRY_KEY_EXPIRED');
  }
  if (!source.firstAttemptAt) {
    await deps.prisma.billingStripeMonthlyCharge.updateMany({
      where: { id: source.id, firstAttemptAt: null },
      data: { firstAttemptAt: now },
    });
  }
  try {
    const item = await deps.stripe.invoiceItems.create({
      customer: params.customerId, invoice: params.invoiceId,
      amount: Number(source.amountMinor), currency: source.currency.toLowerCase(),
      description: 'Monthly service charge', discountable: false,
      period: { start: Math.floor(source.periodStartsAt.getTime() / 1000),
        end: Math.floor(source.periodEndsAt.getTime() / 1000) },
      metadata: { uoa_monthly_charge_key: authorityKey,
        uoa_billing_month: params.billingMonth },
    }, { idempotencyKey: source.idempotencyKey });
    verifyItem(item, source, params);
    await acceptItem(deps.prisma, source, item);
  } catch (error) {
    await deps.prisma.billingStripeMonthlyCharge.updateMany({
      where: { id: source.id, state: { not: 'ACCEPTED' } },
      data: { state: 'HELD', lastErrorCode: error instanceof AppError ?
        error.message : 'STRIPE_MONTHLY_CHARGE_PROVIDER_UNRESOLVED' },
    });
    throw error;
  }
}
