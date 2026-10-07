import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { stripeCalendarBillingMonth } from './billing-stripe-period.service.js';

type StripeLineClient = Pick<Stripe, 'invoices'>;

/** Stripe's invoice header period may cover item creation, not the service month. */
export async function stripeSubscriptionInvoicePeriod(params: {
  invoiceId: string;
  subscriptionId: string;
  usageItemId: string;
  monthlyItemId: string | null;
  livemode: boolean;
  currency: string;
}, stripe: StripeLineClient): Promise<{
  billingMonth: string; startsAt: Date; endsAt: Date;
  monthlyLineObserved: boolean;
}> {
  let after: string | undefined;
  const usagePeriods: Array<{ start: number; end: number }> = [];
  const monthlyPeriods: Array<{ start: number; end: number }> = [];
  for (let page = 0; page < 3; page += 1) {
    const lines = await stripe.invoices.listLineItems(params.invoiceId, {
      limit: 100, ...(after ? { starting_after: after } : {}),
    });
    for (const line of lines.data) {
      const details = line.parent?.type === 'subscription_item_details' ?
        line.parent.subscription_item_details : null;
      if (!details || details.proration ||
        details.subscription !== params.subscriptionId ||
        (details.subscription_item !== params.usageItemId &&
          details.subscription_item !== params.monthlyItemId)) continue;
      if (line.invoice !== params.invoiceId || line.livemode !== params.livemode ||
        line.currency.toUpperCase() !== params.currency ||
        !Number.isSafeInteger(line.period.start) ||
        !Number.isSafeInteger(line.period.end)) {
        throw new AppError('INTERNAL', 502, 'STRIPE_INVOICE_LINE_BINDING_INVALID');
      }
      const target = details.subscription_item === params.usageItemId ?
        usagePeriods : monthlyPeriods;
      target.push({ start: line.period.start, end: line.period.end });
    }
    if (!lines.has_more) break;
    after = lines.data.at(-1)?.id;
    if (!after || page === 2) {
      throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_LINES_UNBOUNDED');
    }
  }
  if (usagePeriods.some((period) =>
    period.start !== usagePeriods[0]?.start || period.end !== usagePeriods[0]?.end) ||
    monthlyPeriods.some((period) =>
      period.start !== monthlyPeriods[0]?.start || period.end !== monthlyPeriods[0]?.end)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_SERVICE_PERIOD_UNPROVEN');
  }
  const monthly = monthlyPeriods[0];
  const period = usagePeriods[0] ?? (monthly ? {
    start: Date.UTC(new Date(monthly.start * 1000).getUTCFullYear(),
      new Date(monthly.start * 1000).getUTCMonth() - 1, 1) / 1000,
    end: monthly.start,
  } : null);
  if (!period) throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_SERVICE_PERIOD_UNPROVEN');
  if (monthly && (monthly.start !== period.end ||
    !stripeCalendarBillingMonth(new Date(monthly.start * 1000),
      new Date(monthly.end * 1000)))) {
    throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_MONTHLY_LINE_PERIOD_INVALID');
  }
  const startsAt = new Date(period.start * 1000);
  const endsAt = new Date(period.end * 1000);
  const billingMonth = stripeCalendarBillingMonth(startsAt, endsAt);
  if (!billingMonth) throw new AppError('INTERNAL', 409, 'STRIPE_INVOICE_SERVICE_PERIOD_INVALID');
  return { billingMonth, startsAt, endsAt,
    monthlyLineObserved: monthlyPeriods.length > 0 };
}
