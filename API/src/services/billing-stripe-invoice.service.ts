import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type Stripe from 'stripe';

import { getAppLogger } from '../utils/app-logger.js';
import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { stripeCalendarBillingMonth } from './billing-stripe-period.service.js';
import { exportStripeUsage, type StripeUsageExportResult } from './billing-stripe-usage.service.js';
import { recordStripeInvoiceClose } from './billing-stripe-invoice-close-state.service.js';

export type StripeInvoiceWebhookType = 'invoice.created' | 'invoice.finalization_failed' | 'invoice.finalized' | 'catchup';

type StripeInvoiceClient = Pick<Stripe, 'accounts' | 'billing' | 'invoices'>;
const MINIMUM_CYCLE_INVOICE_GRACE_SECONDS = 60 * 60;

function externalId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  if (invoice.parent?.type !== 'subscription_details' || !invoice.parent.subscription_details) {
    return null;
  }
  return externalId(invoice.parent.subscription_details.subscription);
}

function invoicePeriod(invoice: Stripe.Invoice): {
  billingMonth: string;
  startsAt: Date;
  endsAt: Date;
} {
  const startsAt = new Date(invoice.period_start * 1000);
  const endsAt = new Date(invoice.period_end * 1000);
  const billingMonth = stripeCalendarBillingMonth(startsAt, endsAt);
  if (!billingMonth) {
    throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_PERIOD_INVALID');
  }
  return { billingMonth, startsAt, endsAt };
}

function logFinalizationFailure(
  invoice: Stripe.Invoice,
  logger: Pick<FastifyBaseLogger, 'error'>,
): void {
  logger.error(
    {
      stripeInvoiceId: invoice.id,
      billingReason: invoice.billing_reason,
      status: invoice.status,
      automaticTaxStatus: invoice.automatic_tax.status,
      finalizationErrorCode: invoice.last_finalization_error?.code ?? null,
      finalizationErrorType: invoice.last_finalization_error?.type ?? null,
    },
    'Stripe invoice finalization failed',
  );
}

export async function reconcileStripeCycleInvoiceUsage(
  params: {
    invoiceId: string;
    eventType: StripeInvoiceWebhookType;
    account: StripeAccountContext;
  },
  deps: {
    prisma: PrismaClient;
    stripe: StripeInvoiceClient;
    exportUsage?: typeof exportStripeUsage;
    manageClose?: boolean;
    now?: () => Date;
    log?: Pick<FastifyBaseLogger, 'error'>;
  },
): Promise<StripeUsageExportResult | null> {
  const manageClose = deps.manageClose ?? !deps.exportUsage;
  const invoice = await deps.stripe.invoices.retrieve(params.invoiceId);
  assertStripeObjectLivemode(invoice, params.account.livemode);
  if (invoice.id !== params.invoiceId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_BINDING_INVALID');
  }
  if (params.eventType === 'invoice.finalization_failed') {
    logFinalizationFailure(invoice, deps.log ?? getAppLogger());
  }
  if (invoice.billing_reason !== 'subscription_cycle') return null;
  const graceInsufficient =
    params.eventType === 'invoice.created' &&
    (typeof invoice.created !== 'number' ||
      typeof invoice.automatically_finalizes_at !== 'number' ||
      invoice.automatically_finalizes_at - invoice.created < MINIMUM_CYCLE_INVOICE_GRACE_SECONDS);
  if (graceInsufficient && !manageClose) {
    throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_GRACE_PERIOD_INSUFFICIENT');
  }
  if (
    invoice.status !== 'draft' ||
    invoice.collection_method !== 'charge_automatically' ||
    invoice.auto_advance === false
  ) {
    if (!manageClose && params.eventType === 'invoice.finalization_failed') return null;
    if (!manageClose) throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_NOT_DRAFT');
  }

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_BINDING_INVALID');
  }
  const period = invoicePeriod(invoice);
  const subscription = await deps.prisma.billingStripeSubscription.findUnique({
    where: {
      accountId_stripeSubscriptionId: {
        accountId: params.account.id,
        stripeSubscriptionId: subscriptionId,
      },
    },
    select: {
      id: true,
      accountId: true,
      livemode: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      customer: { select: { stripeCustomerId: true } },
      tariff: { select: { currency: true } },
    },
  });
  const samePeriod =
    subscription?.currentPeriodStart?.getTime() === period.startsAt.getTime() &&
    subscription.currentPeriodEnd?.getTime() === period.endsAt.getTime();
  const advancedToNextPeriod =
    subscription?.currentPeriodStart?.getTime() === period.endsAt.getTime() &&
    Boolean(
      stripeCalendarBillingMonth(subscription.currentPeriodStart, subscription.currentPeriodEnd),
    );
  if (
    !subscription ||
    subscription.accountId !== params.account.id ||
    subscription.livemode !== params.account.livemode ||
    externalId(invoice.customer) !== subscription.customer.stripeCustomerId ||
    invoice.currency.toUpperCase() !== subscription.tariff.currency ||
    (!samePeriod && !advancedToNextPeriod)
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_BINDING_INVALID');
  }
  if (invoice.collection_method !== 'charge_automatically') {
    throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_BINDING_INVALID');
  }

  const now = deps.now?.() ?? new Date();
  const closeIdentity = {
    accountId: params.account.id,
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    billingMonth: period.billingMonth,
    periodStartsAt: period.startsAt,
    periodEndsAt: period.endsAt,
    currency: subscription.tariff.currency,
    now,
  };
  if (invoice.status !== 'draft') {
    await recordStripeInvoiceClose({ ...closeIdentity, state: 'FINALIZED_HOLD',
      lastError: 'STRIPE_INVOICE_ALREADY_FINALIZED' }, deps.prisma);
    return null;
  }
  try {
    if (graceInsufficient) throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_GRACE_PERIOD_INSUFFICIENT');
    const result = await (deps.exportUsage ?? exportStripeUsage)(
      { subscriptionId: subscription.id, billingMonth: period.billingMonth },
      {
        prisma: deps.prisma,
        stripe: deps.stripe,
        stripeLivemode: params.account.livemode,
        invoicePeriod: { startsAt: period.startsAt, endsAt: period.endsAt },
        now: deps.now,
      },
    );
    if (manageClose) {
      const prior = await deps.prisma.billingStripeInvoiceClose.findUnique({
        where: { stripeInvoiceId: invoice.id },
      });
      const held = prior?.state === 'HELD' || prior?.state === 'READY' || invoice.auto_advance === false;
      await recordStripeInvoiceClose({ ...closeIdentity,
        state: held ? 'READY' : 'RELEASED',
        ledgerSnapshotCursor: result.ledgerSnapshotCursor,
        readyAt: held ? (prior?.readyAt ?? new Date(now.getTime() + 60 * 60_000)) : null,
      }, deps.prisma);
    }
    return result;
  } catch (error) {
    if (!manageClose) throw error;
    const paused = await deps.stripe.invoices.update(invoice.id, { auto_advance: false });
    assertStripeObjectLivemode(paused, params.account.livemode);
    if (paused.id !== invoice.id || paused.status !== 'draft' || paused.auto_advance !== false) {
      throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_HOLD_NOT_CONFIRMED');
    }
    await recordStripeInvoiceClose({ ...closeIdentity, state: 'HELD',
      lastError: error instanceof AppError ? error.message : 'STRIPE_INVOICE_SETTLEMENT_FAILED' },
    deps.prisma);
    return null;
  }
}
