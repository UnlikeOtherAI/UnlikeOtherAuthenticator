import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { stripeInvoiceMinor } from './billing-stripe-payment-evidence.service.js';

export type VerifiedStripeInvoiceLine = {
  stripeLineId: string; serviceId: string; serviceIdentifier: string;
  billingMonth: string; label: string; subscriptionMinor: bigint; usageMinor: bigint;
  taxMinor: bigint; creditMinor: bigint; grossMinor: bigint; dueMinor: bigint;
};

function hold(): never {
  throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_LINES_UNPROVEN');
}

export async function verifyStripePaymentInvoiceLines(params: {
  invoice: Stripe.Invoice; accountId: string; subscriptionId: string;
  orgId: string; stripeCustomerId: string;
}, prisma: PrismaClient, stripe: Pick<Stripe, 'invoices'>): Promise<VerifiedStripeInvoiceLine[]> {
  const subscriptions = await prisma.billingStripeSubscription.findMany({
    where: { accountId: params.accountId, orgId: params.orgId,
      customer: { stripeCustomerId: params.stripeCustomerId } },
    include: { service: true, tariff: { select: { currency: true } } },
  });
  const monthlies = await prisma.billingStripeMonthlyCharge.findMany({
    where: { accountId: params.accountId, stripeInvoiceId: params.invoice.id, state: 'ACCEPTED' },
  });
  const result: VerifiedStripeInvoiceLine[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let complete = false;
  for (let page = 0; page < 10; page += 1) {
    const rows = await stripe.invoices.listLineItems(params.invoice.id, { limit: 100,
      ...(after ? { starting_after: after } : {}) });
    for (const line of rows.data) {
      if (seen.has(line.id) || line.invoice !== params.invoice.id ||
        line.currency !== params.invoice.currency || line.livemode !== params.invoice.livemode ||
        line.discount_amounts?.some((row) => row.amount !== 0) ||
        line.pretax_credit_amounts?.some((row) => row.amount !== 0) ||
        !Number.isSafeInteger(line.period.start) || !Number.isSafeInteger(line.period.end) ||
        line.period.end <= line.period.start) hold();
      seen.add(line.id);
      const details = line.parent?.type === 'subscription_item_details' ?
        line.parent.subscription_item_details : null;
      const itemId = line.parent?.type === 'invoice_item_details' ?
        line.parent.invoice_item_details?.invoice_item : null;
      const monthly = itemId ? monthlies.find((row) => row.stripeInvoiceItemId === itemId) : null;
      const subscription = monthly ? subscriptions.find((row) => row.id === monthly.subscriptionId) :
        subscriptions.find((row) => row.stripeSubscriptionId === details?.subscription);
      if (!subscription || subscription.livemode !== params.invoice.livemode ||
        subscription.tariff.currency !== params.invoice.currency.toUpperCase() ||
        (details && details.subscription_item !== subscription.stripeUsageItemId &&
          details.subscription_item !== subscription.stripeMonthlyItemId) ||
        (!details && !monthly)) hold();
      if (monthly && (monthly.currency !== line.currency.toUpperCase() ||
        monthly.amountMinor !== stripeInvoiceMinor(line.amount) ||
        monthly.periodStartsAt.getTime() !== line.period.start * 1000 ||
        monthly.periodEndsAt.getTime() !== line.period.end * 1000)) hold();
      if (line.taxes === null) hold();
      const taxMinor = line.taxes.reduce((sum, tax) => sum + stripeInvoiceMinor(tax.amount), 0n);
      const inclusiveTax = line.taxes.filter((tax) => tax.tax_behavior === 'inclusive')
        .reduce((sum, tax) => sum + stripeInvoiceMinor(tax.amount), 0n);
      const amount = stripeInvoiceMinor(line.amount);
      if (inclusiveTax > amount) hold();
      const base = amount - inclusiveTax;
      const usage = Boolean(details && details.subscription_item === subscription.stripeUsageItemId);
      const at = new Date(line.period.start * 1000);
      if (Number.isNaN(at.getTime())) hold();
      result.push({ stripeLineId: line.id, serviceId: subscription.serviceId,
        serviceIdentifier: subscription.service.identifier,
        billingMonth: monthly?.billingMonth ?? at.toISOString().slice(0, 7),
        label: `${subscription.service.name} ${usage ? 'usage charge' : 'monthly subscription'}`,
        subscriptionMinor: usage ? 0n : base, usageMinor: usage ? base : 0n,
        taxMinor, creditMinor: 0n, grossMinor: base + taxMinor, dueMinor: base + taxMinor });
    }
    if (!rows.has_more) { complete = true; break; }
    after = rows.data.at(-1)?.id;
    if (!after) break;
  }
  result.sort((a, b) => Buffer.compare(Buffer.from(a.stripeLineId), Buffer.from(b.stripeLineId)));
  const gross = stripeInvoiceMinor(params.invoice.total);
  const due = stripeInvoiceMinor(params.invoice.amount_due);
  if (!complete || result.length === 0 || due > gross ||
    result.reduce((sum, row) => sum + row.grossMinor, 0n) !== gross ||
    params.invoice.total_taxes === null ||
    result.reduce((sum, row) => sum + row.taxMinor, 0n) !==
      params.invoice.total_taxes.reduce((sum, row) => sum + stripeInvoiceMinor(row.amount), 0n)) hold();
  const credit = gross - due;
  if (credit > 0n) {
    if (gross === 0n) hold();
    let allocated = 0n;
    const fractions = result.map((row) => {
      row.creditMinor = credit * row.grossMinor / gross;
      allocated += row.creditMinor;
      return { row, remainder: credit * row.grossMinor % gross };
    }).sort((a, b) => a.remainder === b.remainder ?
      Buffer.compare(Buffer.from(a.row.stripeLineId), Buffer.from(b.row.stripeLineId)) :
      a.remainder > b.remainder ? -1 : 1);
    for (const fraction of fractions) {
      if (allocated >= credit) break;
      fraction.row.creditMinor += 1n; allocated += 1n;
    }
    if (allocated !== credit) hold();
    for (const row of result) row.dueMinor = row.grossMinor - row.creditMinor;
  }
  return result;
}
