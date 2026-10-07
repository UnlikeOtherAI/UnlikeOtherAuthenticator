import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';
import { assertStripeObjectLivemode, requireStripeBillingEnabled, resolveStripeAccountContext }
  from './billing-stripe-client.service.js';
import { collectStripeMonthlyCharge } from './billing-stripe-monthly-charge.service.js';
import { freezeStripeMonthlyChargeSource } from './billing-stripe-monthly-charge-source.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { resumeCanceledStripeRenewal } from './billing-stripe-canceled-renewal.service.js';
import type { quoteUnexportedClosedPeriodLiability }
  from './billing-stripe-invoice-close-quote.service.js';

type Client = Pick<Stripe, 'accounts' | 'subscriptions' | 'invoices' | 'invoiceItems'>;
type Source = Awaited<ReturnType<typeof freezeStripeMonthlyChargeSource>>;

function hold(code: string): never { throw new AppError('INTERNAL', 409, code); }

function verifyClosingInvoice(invoice: Stripe.Invoice, source: Source, customerId: string,
  livemode: boolean): void {
  assertStripeObjectLivemode(invoice, livemode);
  if (stripeExternalId(invoice.customer) !== customerId ||
    invoice.currency.toUpperCase() !== source.currency ||
    invoice.metadata?.uoa_monthly_charge_key !== source.authorityKey ||
    invoice.metadata?.uoa_monthly_subscription_id !== source.subscriptionId ||
    invoice.collection_method !== 'charge_automatically' ||
    !['draft', 'open', 'paid'].includes(invoice.status ?? '')) hold('STRIPE_CLOSING_INVOICE_BINDING_UNPROVEN');
}

async function recoverClosingInvoice(stripe: Client, source: Source, customerId: string,
  firstAttemptAt: Date) {
  let after: string | undefined; let found: Stripe.Invoice | null = null;
  for (let page = 0; page < 3; page += 1) {
    const rows = await stripe.invoices.list({ customer: customerId, limit: 100,
      created: { gte: Math.floor(firstAttemptAt.getTime() / 1000) - 60 },
      ...(after ? { starting_after: after } : {}) });
    for (const invoice of rows.data) {
      if (invoice.metadata?.uoa_monthly_charge_key !== source.authorityKey) continue;
      if (found) hold('STRIPE_CLOSING_INVOICE_REMOTE_DUPLICATE');
      found = invoice;
    }
    if (!rows.has_more) return found;
    after = rows.data.at(-1)?.id;
    if (!after) break;
  }
  hold('STRIPE_CLOSING_INVOICE_RECOVERY_UNBOUNDED');
}

async function verifyClosingDraftLines(stripe: Client, invoice: Stripe.Invoice,
  source: Source, itemId: string | null) {
  if (!itemId) hold('STRIPE_CLOSING_INVOICE_ITEM_UNPROVEN');
  const rows = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
  if (rows.has_more || rows.data.length !== 1) hold('STRIPE_CLOSING_INVOICE_LINES_UNPROVEN');
  const line = rows.data[0];
  if (!line || line.invoice !== invoice.id || line.livemode !== invoice.livemode ||
    line.currency.toUpperCase() !== source.currency || line.amount !== Number(source.amountMinor) ||
    line.parent?.type !== 'invoice_item_details' ||
    line.parent.invoice_item_details?.invoice_item !== itemId ||
    line.discount_amounts?.some((entry) => entry.amount !== 0) ||
    line.pretax_credit_amounts?.some((entry) => entry.amount !== 0) ||
    line.period.start !== Math.floor(source.periodStartsAt.getTime() / 1000) ||
    line.period.end !== Math.floor(source.periodEndsAt.getTime() / 1000)) {
    hold('STRIPE_CLOSING_INVOICE_LINES_UNPROVEN');
  }
}

/** The durable month watch collects earned seats after a subscription ends. */
export async function collectStripeClosingSeatInvoice(params: {
  subscriptionId: string; billingMonth: string;
}, deps: { prisma: PrismaClient; stripe?: Client; stripeLivemode?: boolean;
  quote?: typeof quoteSubscriptionMonthlyCharge; now?: () => Date;
  quoteUsage?: typeof quoteUnexportedClosedPeriodLiability }) {
  if (!deps.stripe && !getEnv().STRIPE_BILLING_ENABLED) return null;
  const row = await deps.prisma.billingStripeSubscription.findUnique({
    where: { id: params.subscriptionId }, include: { tariff: true, customer: true },
  });
  if (!row || row.status !== 'canceled' || row.tariff.monthlyChargeBasis !== 'PER_SEAT' ||
    !row.billableUntil || !row.billableFrom) return null;
  const lastMonth = new Date(row.billableUntil.getTime() - 1).toISOString().slice(0, 7);
  if (lastMonth !== params.billingMonth) return null;
  const start = new Date(`${lastMonth}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const now = deps.now?.() ?? new Date();
  if (end > now) return null;
  const configured = deps.stripe ? null : requireStripeBillingEnabled();
  const stripe = deps.stripe ?? configured?.client;
  if (!stripe) hold('STRIPE_BILLING_DISABLED');
  const account = await resolveStripeAccountContext(stripe,
    deps.stripeLivemode ?? configured?.livemode ?? false, deps.prisma);
  if (account.id !== row.accountId || account.livemode !== row.livemode ||
    row.customer.accountId !== row.accountId || row.customer.orgId !== row.orgId ||
    row.customer.teamId !== row.teamId || !row.customer.stripeCustomerId) {
    hold('STRIPE_CLOSING_INVOICE_SCOPE_UNPROVEN');
  }
  const quote = await (deps.quote ?? quoteSubscriptionMonthlyCharge)({
    source: { kind: 'stripe', id: row.id }, billingMonth: lastMonth,
  }, { prisma: deps.prisma, now: deps.now });
  const source = await freezeStripeMonthlyChargeSource(quote, {
    accountId: row.accountId, subscriptionId: row.id, billingMonth: lastMonth,
    periodStartsAt: start, periodEndsAt: end, currency: row.tariff.currency,
  }, deps.prisma);
  if (source.state === 'NO_CHARGE') return source;
  if (source.allocationKind === 'RENEWAL') {
    await resumeCanceledStripeRenewal({ sourceId: source.id, subscriptionId: row.id },
      { prisma: deps.prisma, stripe, quoteUsage: deps.quoteUsage });
    return source;
  }
  if (source.allocationKind !== 'CLOSING') hold('STRIPE_CLOSING_INVOICE_SOURCE_UNPROVEN');
  const token = randomUUID();
  const lease = await deps.prisma.$queryRaw<Array<{ firstInvoiceAttemptAt: Date }>>(Prisma.sql`
    UPDATE billing_stripe_monthly_charges SET invoice_lease_token = ${token}::uuid,
      invoice_lease_expires_at = now() + interval '3 minutes',
      first_invoice_attempt_at = coalesce(first_invoice_attempt_at, now())
    WHERE id = ${source.id} AND (invoice_lease_expires_at IS NULL OR invoice_lease_expires_at <= now())
    RETURNING first_invoice_attempt_at AS "firstInvoiceAttemptAt"
  `);
  if (!lease[0]) hold('STRIPE_CLOSING_INVOICE_LEASE_BUSY');
  const assertLease = async (creating = false) => {
    const permission = await deps.prisma.$queryRaw<Array<{ active: boolean; retryAllowed: boolean }>>(Prisma.sql`
      SELECT invoice_lease_token = ${token}::uuid AND invoice_lease_expires_at > clock_timestamp() AS active,
        first_invoice_attempt_at > clock_timestamp() - interval '23 hours' AS "retryAllowed"
      FROM billing_stripe_monthly_charges WHERE id = ${source.id}`);
    if (!permission[0]?.active) hold('STRIPE_CLOSING_INVOICE_LEASE_LOST');
    if (creating && !permission[0].retryAllowed) hold('STRIPE_CLOSING_INVOICE_RETRY_KEY_EXPIRED');
  };
  try {
    const remote = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
    assertStripeObjectLivemode(remote, row.livemode);
    if (remote.id !== row.stripeSubscriptionId || remote.status !== 'canceled' ||
      stripeExternalId(remote.customer) !== row.customer.stripeCustomerId ||
      remote.metadata.uoa_checkout_id !== row.checkoutId) hold('STRIPE_CLOSING_SUBSCRIPTION_UNPROVEN');
    let invoice = source.stripeInvoiceId ? await stripe.invoices.retrieve(source.stripeInvoiceId) :
      await recoverClosingInvoice(stripe, source, row.customer.stripeCustomerId,
        lease[0].firstInvoiceAttemptAt);
    if (!invoice) {
      await assertLease(true);
      const paymentMethod = stripeExternalId(remote.default_payment_method);
      if (!remote.automatic_tax || !Array.isArray(remote.default_tax_rates) ||
        (remote.automatic_tax.enabled && remote.default_tax_rates.length > 0)) {
        hold('STRIPE_CLOSING_INVOICE_TAX_POLICY_UNPROVEN');
      }
      invoice = await stripe.invoices.create({ customer: row.customer.stripeCustomerId,
        currency: source.currency.toLowerCase(), collection_method: 'charge_automatically',
        auto_advance: false, pending_invoice_items_behavior: 'exclude',
        automatic_tax: { enabled: remote.automatic_tax.enabled },
        ...(!remote.automatic_tax.enabled && remote.default_tax_rates.length > 0 ?
          { default_tax_rates: remote.default_tax_rates.map((rate) => rate.id) } : {}),
        ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
        metadata: { uoa_monthly_charge_key: source.authorityKey,
          uoa_monthly_subscription_id: row.id, uoa_billing_month: lastMonth },
      }, { idempotencyKey: `uoa-monthly-invoice-${source.authorityKey}` });
    }
    verifyClosingInvoice(invoice, source, row.customer.stripeCustomerId, row.livemode);
    if (source.stripeInvoiceId && source.stripeInvoiceId !== invoice.id) hold('STRIPE_CLOSING_INVOICE_CHANGED');
    await assertLease();
    const attached = await deps.prisma.billingStripeMonthlyCharge.updateMany({ where: {
      id: source.id, invoiceLeaseToken: token,
    }, data: { stripeInvoiceId: invoice.id } });
    if (attached.count !== 1) hold('STRIPE_CLOSING_INVOICE_LEASE_LOST');
    if (invoice.status === 'draft') {
      await collectStripeMonthlyCharge({ subscriptionId: row.id, accountId: row.accountId,
        invoiceId: invoice.id, customerId: row.customer.stripeCustomerId, livemode: row.livemode,
        billingMonth: lastMonth, periodStartsAt: start, periodEndsAt: end,
        currency: source.currency, stripeMonthlyItemId: null, monthlyLineObserved: false,
        closingCancellation: true, closingLeaseToken: token }, { prisma: deps.prisma, stripe, quote: deps.quote, now: deps.now });
      const accepted = await deps.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({ where: { id: source.id } });
      await verifyClosingDraftLines(stripe, invoice, source, accepted.stripeInvoiceItemId);
      await assertLease();
      const finalized = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
      verifyClosingInvoice(finalized, source, row.customer.stripeCustomerId, row.livemode);
      if (finalized.id !== invoice.id || finalized.status === 'draft') hold('STRIPE_CLOSING_INVOICE_FINALIZATION_PENDING');
    } else if (source.state !== 'ACCEPTED') hold('STRIPE_CLOSING_INVOICE_ITEM_UNPROVEN');
    return deps.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({ where: { id: source.id } });
  } finally {
    await deps.prisma.billingStripeMonthlyCharge.updateMany({ where: {
      id: source.id, invoiceLeaseToken: token,
    }, data: { invoiceLeaseToken: null, invoiceLeaseExpiresAt: null } });
  }
}
