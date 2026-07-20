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

export type StripeInvoiceWebhookType = 'invoice.created' | 'invoice.finalization_failed';

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
    now?: () => Date;
    log?: Pick<FastifyBaseLogger, 'error'>;
  },
): Promise<StripeUsageExportResult | null> {
  const invoice = await deps.stripe.invoices.retrieve(params.invoiceId);
  assertStripeObjectLivemode(invoice, params.account.livemode);
  if (invoice.id !== params.invoiceId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_BINDING_INVALID');
  }
  if (params.eventType === 'invoice.finalization_failed') {
    logFinalizationFailure(invoice, deps.log ?? getAppLogger());
  }
  if (invoice.billing_reason !== 'subscription_cycle') return null;
  if (
    params.eventType === 'invoice.created' &&
    (typeof invoice.created !== 'number' ||
      typeof invoice.automatically_finalizes_at !== 'number' ||
      invoice.automatically_finalizes_at - invoice.created < MINIMUM_CYCLE_INVOICE_GRACE_SECONDS)
  ) {
    throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_GRACE_PERIOD_INSUFFICIENT');
  }
  if (
    invoice.status !== 'draft' ||
    invoice.collection_method !== 'charge_automatically' ||
    invoice.auto_advance === false
  ) {
    if (params.eventType === 'invoice.finalization_failed') return null;
    throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_NOT_DRAFT');
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

  return (deps.exportUsage ?? exportStripeUsage)(
    {
      subscriptionId: subscription.id,
      billingMonth: period.billingMonth,
    },
    {
      prisma: deps.prisma,
      stripe: deps.stripe,
      stripeLivemode: params.account.livemode,
      invoicePeriod: {
        startsAt: period.startsAt,
        endsAt: period.endsAt,
      },
      now: deps.now,
    },
  );
}
