import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { correctionMetadata, freezeStripeCorrectionSource }
  from './billing-stripe-correction-source.service.js';
import { correctionBuyer, correctionDigest, correctionHold, correctionTaxMinor,
  type FrozenCorrectionTax } from './billing-stripe-correction-tax.service.js';
import { compensateFinalizedStripeInvoice }
  from './billing-stripe-invoice-close-resolution.service.js';
import type { StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Client = StripeInvoiceCashClient & Pick<Stripe, 'accounts' | 'subscriptions' | 'invoiceItems' | 'taxRates'>;

async function recoverInvoice(stripe: Client, customer: string, key: string, since: Date) {
  let after: string | undefined; let found: Stripe.Invoice | null = null;
  for (let page = 0; page < 3; page += 1) {
    const rows = await stripe.invoices.list({ customer, limit: 100,
      created: { gte: Math.floor(since.getTime() / 1000) - 60 },
      ...(after ? { starting_after: after } : {}) });
    for (const row of rows.data) {
      if (row.metadata?.uoa_cycle_correction_key !== key) continue;
      if (found) correctionHold('STRIPE_CORRECTION_REMOTE_DUPLICATE');
      found = row;
    }
    if (!rows.has_more) return found;
    after = rows.data.at(-1)?.id;
    if (!after) break;
  }
  correctionHold('STRIPE_CORRECTION_RECOVERY_UNBOUNDED');
}

export async function collectStripeCorrectionInvoice(params: {
  closeId: string; amountMicroMinor: bigint; cursor: string;
}, deps: { prisma: PrismaClient; stripe: Client }) {
  const { prisma, stripe } = deps;
  const source = await freezeStripeCorrectionSource(params, prisma, stripe);
  const close = await prisma.billingStripeInvoiceClose.findUniqueOrThrow({
    where: { id: source.closeId }, include: { subscription: true } });
  const account = await prisma.billingStripeAccount.findUniqueOrThrow({
    where: { id: close.accountId } });
  if ((await stripe.accounts.retrieveCurrent()).id !== account.stripeAccountId ||
    account.livemode !== close.subscription.livemode) {
    correctionHold('STRIPE_CORRECTION_PROCESSOR_ACCOUNT_UNPROVEN');
  }
  const policy = source.taxPolicy as unknown as FrozenCorrectionTax;
  const metadata = correctionMetadata(close, close.subscription.serviceId, source.authorityKey);
  const tax = correctionTaxMinor(source.amountMinor, policy);
  const itemAmount = source.amountMinor + (policy.behavior === 'inclusive' ? tax : 0n);
  if (source.amountMinor + tax > BigInt(Number.MAX_SAFE_INTEGER)) {
    correctionHold('STRIPE_CORRECTION_GROSS_AMOUNT_UNPROVEN');
  }
  const token = randomUUID();
  const lease = await prisma.$queryRaw<Array<{ firstAttemptAt: Date }>>(Prisma.sql`
    UPDATE billing_stripe_cycle_corrections SET lease_token = ${token}::uuid,
      lease_expires_at = now() + interval '3 minutes',
      first_attempt_at = coalesce(first_attempt_at, now())
    WHERE id = ${source.id}::uuid AND paid_at IS NULL
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    RETURNING first_attempt_at AS "firstAttemptAt"`);
  if (!lease[0]) correctionHold('STRIPE_CORRECTION_LEASE_BUSY');
  const update = async (data: Prisma.BillingStripeCycleCorrectionUpdateManyMutationInput) => {
    await assertLease();
    const result = await prisma.billingStripeCycleCorrection.updateMany({
      where: { id: source.id, leaseToken: token }, data });
    if (result.count !== 1) correctionHold('STRIPE_CORRECTION_LEASE_LOST');
  };
  const assertLease = async (creating = false) => {
    const rows = await prisma.$queryRaw<Array<{ active: boolean; retryAllowed: boolean }>>(Prisma.sql`
      SELECT lease_token = ${token}::uuid AND lease_expires_at > clock_timestamp() AS active,
        first_attempt_at > clock_timestamp() - interval '23 hours' AS "retryAllowed"
      FROM billing_stripe_cycle_corrections WHERE id = ${source.id}::uuid`);
    if (!rows[0]?.active) correctionHold('STRIPE_CORRECTION_LEASE_LOST');
    if (creating && !rows[0].retryAllowed) correctionHold('STRIPE_CORRECTION_RETRY_KEY_EXPIRED');
  };
  const verifyInvoice = (invoice: Stripe.Invoice) => {
    assertStripeObjectLivemode(invoice, close.subscription.livemode);
    if (stripeExternalId(invoice.customer) !== policy.customerId ||
      invoice.currency.toUpperCase() !== source.currency || invoice.parent !== null ||
      invoice.collection_method !== 'charge_automatically' ||
      !['draft', 'open', 'paid'].includes(invoice.status ?? '') ||
      !Object.entries(metadata).every(([key, value]) => invoice.metadata?.[key] === value)) {
      correctionHold('STRIPE_CORRECTION_INVOICE_UNPROVEN');
    }
  };
  const lines = async (invoice: Stripe.Invoice, requiredItemId: string | null) => {
    const rows = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
    if (rows.has_more || rows.data.length > 1 || (requiredItemId && rows.data.length !== 1)) {
      correctionHold('STRIPE_CORRECTION_LINES_UNPROVEN');
    }
    const line = rows.data[0];
    if (!line) return null;
    const itemId = line.parent?.type === 'invoice_item_details' ?
      line.parent.invoice_item_details?.invoice_item : null;
    if (!itemId || (requiredItemId && itemId !== requiredItemId) ||
      line.invoice !== invoice.id || line.livemode !== invoice.livemode ||
      line.currency !== invoice.currency || line.amount !== Number(itemAmount) ||
      line.period.start !== close.periodStartsAt.getTime() / 1000 ||
      line.period.end !== close.periodEndsAt.getTime() / 1000 ||
      line.discount_amounts?.some((row) => row.amount !== 0) ||
      line.pretax_credit_amounts?.some((row) => row.amount !== 0) ||
      !Object.entries(metadata).every(([key, value]) => line.metadata?.[key] === value)) {
      correctionHold('STRIPE_CORRECTION_LINES_UNPROVEN');
    }
    if (invoice.status !== 'draft' && (line.taxes === null ||
      line.taxes.some((row) => row.tax_behavior !== policy.behavior) ||
      line.taxes.reduce((sum, row) => sum + BigInt(row.amount), 0n) !== tax ||
      invoice.total !== Number(source.amountMinor + tax) ||
      invoice.amount_due !== invoice.total || invoice.total_taxes === null ||
      invoice.total_taxes.reduce((sum, row) => sum + BigInt(row.amount), 0n) !== tax ||
      correctionDigest(correctionBuyer(invoice)) !== correctionDigest(policy.buyer))) {
      correctionHold('STRIPE_CORRECTION_FINAL_TAX_OR_PAYER_UNPROVEN');
    }
    return itemId;
  };
  try {
    let invoice = source.stripeInvoiceId ? await stripe.invoices.retrieve(source.stripeInvoiceId) :
      await recoverInvoice(stripe, policy.customerId, source.authorityKey, lease[0].firstAttemptAt);
    if (!invoice) {
      await assertLease(true);
      invoice = await stripe.invoices.create({ customer: policy.customerId,
        currency: source.currency.toLowerCase(), collection_method: 'charge_automatically',
        pending_invoice_items_behavior: 'exclude', auto_advance: false,
        automatic_tax: { enabled: false }, default_tax_rates: [], metadata,
        ...(policy.paymentMethodId ? { default_payment_method: policy.paymentMethodId } : {}),
      }, { idempotencyKey: `uoa-cycle-correction-${source.authorityKey}` });
    }
    verifyInvoice(invoice);
    if (source.stripeInvoiceId && source.stripeInvoiceId !== invoice.id) {
      correctionHold('STRIPE_CORRECTION_INVOICE_CHANGED');
    }
    await update({ stripeInvoiceId: invoice.id });
    let itemId = await lines(invoice, source.stripeInvoiceItemId);
    if (!itemId) {
      if (invoice.status !== 'draft') correctionHold('STRIPE_CORRECTION_ITEM_UNPROVEN');
      await assertLease(true);
      const item = await stripe.invoiceItems.create({ customer: policy.customerId,
        invoice: invoice.id, currency: source.currency.toLowerCase(), amount: Number(itemAmount),
        tax_behavior: policy.behavior, tax_rates: policy.rates.map((rate) => rate.id),
        discountable: false, description: 'Additional usage credits', metadata,
        period: { start: close.periodStartsAt.getTime() / 1000, end: close.periodEndsAt.getTime() / 1000 },
      }, { idempotencyKey: `uoa-cycle-correction-item-${source.authorityKey}` });
      itemId = item.id;
    }
    await update({ stripeInvoiceItemId: itemId });
    await lines(invoice, itemId);
    if (invoice.status === 'draft') {
      await assertLease();
      invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
      verifyInvoice(invoice);
      if (invoice.status === 'draft') correctionHold('STRIPE_CORRECTION_FINALIZATION_PENDING');
    }
    await lines(invoice, itemId);
    if (invoice.status === 'paid') {
      await compensateFinalizedStripeInvoice({ closeId: close.id,
        adjustmentInvoiceId: invoice.id, actorEmail: 'billing-cycle-scheduler',
        observedAt: new Date(), correctionId: source.id }, { prisma, stripe });
    } else if (!invoice.auto_advance) {
      await assertLease();
      const resumed = await stripe.invoices.update(invoice.id, { auto_advance: true });
      verifyInvoice(resumed);
      if (!resumed.auto_advance) correctionHold('STRIPE_CORRECTION_COLLECTION_UNCONFIRMED');
    }
    return { correctionId: source.id, stripeInvoiceId: invoice.id };
  } finally {
    await prisma.billingStripeCycleCorrection.updateMany({ where: {
      id: source.id, leaseToken: token,
    }, data: { leaseToken: null, leaseExpiresAt: null } });
  }
}
