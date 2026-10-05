import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { verifyStripePaymentInvoiceLines } from './billing-stripe-payment-lines.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export type FrozenCorrectionTax = {
  originalInvoiceId: string; customerId: string; paymentMethodId: string | null;
  behavior: 'inclusive' | 'exclusive';
  rates: Array<{ id: string; percentage: string }>;
  buyer: unknown;
};
export function correctionHold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}
export function correctionDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value,
    (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b))));
      }
      return item;
    })).digest('hex');
}
export function correctionBuyer(invoice: Stripe.Invoice) {
  return { name: invoice.customer_name, email: invoice.customer_email,
    address: invoice.customer_address, taxExempt: invoice.customer_tax_exempt,
    taxIds: invoice.customer_tax_ids };
}
export function correctionTaxMinor(net: bigint, policy: FrozenCorrectionTax): bigint {
  return policy.rates.reduce((sum, rate) => {
    if (!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,6})?$/.test(rate.percentage)) {
      correctionHold('STRIPE_CORRECTION_TAX_PERCENTAGE_UNPROVEN');
    }
    const [whole, fraction = ''] = rate.percentage.split('.');
    const denominator = 100n * 10n ** BigInt(fraction.length);
    const numerator = BigInt(`${whole}${fraction}`);
    if (numerator > denominator) correctionHold('STRIPE_CORRECTION_TAX_PERCENTAGE_UNPROVEN');
    return sum + (net * numerator + denominator / 2n) / denominator;
  }, 0n);
}

/** Freeze actual original rates, never infer a percentage from rounded VAT. */
export async function freezeCorrectionTax(params: {
  invoiceId: string; subscriptionId: string; accountId: string; orgId: string;
  customerId: string; serviceId: string; month: string; currency: string; livemode: boolean;
}, prisma: PrismaClient, stripe: Pick<Stripe, 'invoices' | 'taxRates'>) {
  const invoice = await stripe.invoices.retrieve(params.invoiceId);
  assertStripeObjectLivemode(invoice, params.livemode);
  if (invoice.id !== params.invoiceId || !['open', 'paid'].includes(invoice.status ?? '') ||
    invoice.currency.toUpperCase() !== params.currency ||
    stripeExternalId(invoice.customer) !== params.customerId ||
    !invoice.automatic_tax || !Array.isArray(invoice.default_tax_rates)) {
    correctionHold('STRIPE_CORRECTION_ORIGINAL_UNPROVEN');
  }
  const verified = await verifyStripePaymentInvoiceLines({ invoice,
    accountId: params.accountId, subscriptionId: params.subscriptionId,
    orgId: params.orgId, stripeCustomerId: params.customerId }, prisma, stripe);
  if (verified.some((line) => line.serviceId !== params.serviceId ||
    line.billingMonth !== params.month)) correctionHold('STRIPE_CORRECTION_ORIGINAL_SCOPE_UNPROVEN');
  // Complete verified lines can be bounded to one processor page here. A larger
  // original is held for issuer review instead of guessing its tax treatment.
  const rows = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
  if (rows.has_more || rows.data.length !== verified.length) {
    correctionHold('STRIPE_CORRECTION_TAX_LINES_INCOMPLETE');
  }
  const relevant = rows.data.filter((row) => verified.some((line) =>
    line.stripeLineId === row.id && line.usageMinor > 0n));
  const taxable = relevant.length > 0 ? relevant : rows.data;
  const signatures = taxable.map((line) => {
    if (line.taxes === null) correctionHold('STRIPE_CORRECTION_TAX_UNPROVEN');
    return [...new Set(line.taxes.map((tax) => tax.tax_rate_details?.tax_rate ??
      correctionHold('STRIPE_CORRECTION_TAX_UNPROVEN')))].sort();
  });
  if (signatures.some((ids) => JSON.stringify(ids) !== JSON.stringify(signatures[0]))) {
    correctionHold('STRIPE_CORRECTION_MIXED_TAX_TREATMENT');
  }
  const ids = signatures[0]?.length ? signatures[0] : invoice.default_tax_rates.map((rate) => rate.id).sort();
  if (ids.length === 0 && invoice.automatic_tax.enabled) {
    correctionHold('STRIPE_CORRECTION_ZERO_TAX_AUTHORITY_UNPROVEN');
  }
  const rates: FrozenCorrectionTax['rates'] = [];
  const behaviors = new Set<'inclusive' | 'exclusive'>(taxable.flatMap((line) =>
    (line.taxes ?? []).map((tax) => tax.tax_behavior)));
  if (behaviors.size > 1) correctionHold('STRIPE_CORRECTION_MIXED_TAX_TREATMENT');
  const recordedBehavior = [...behaviors][0];
  const defaultBehaviors = new Set<'inclusive' | 'exclusive'>();
  for (const id of ids) {
    const rate = await stripe.taxRates.retrieve(id);
    if (rate.id !== id || !rate.active || rate.livemode !== params.livemode ||
      rate.rate_type !== 'percentage' || rate.flat_amount !== null ||
      (invoice.automatic_tax.enabled && rate.effective_percentage !== rate.percentage)) {
      correctionHold('STRIPE_CORRECTION_TAX_RATE_UNPROVEN');
    }
    defaultBehaviors.add(rate.inclusive ? 'inclusive' : 'exclusive');
    rates.push({ id, percentage: String(rate.percentage) });
  }
  if (!recordedBehavior && defaultBehaviors.size > 1) {
    correctionHold('STRIPE_CORRECTION_MIXED_TAX_TREATMENT');
  }
  const policy: FrozenCorrectionTax = { originalInvoiceId: invoice.id,
    customerId: params.customerId,
    paymentMethodId: stripeExternalId(invoice.default_payment_method),
    rates, behavior: recordedBehavior ?? [...defaultBehaviors][0] ?? 'exclusive',
    buyer: correctionBuyer(invoice) };
  correctionTaxMinor(1n, policy);
  const digest = correctionDigest({ policy, original: verified,
    automaticTax: invoice.automatic_tax.enabled,
    defaults: invoice.default_tax_rates.map((rate) => rate.id) });
  return { policy, digest };
}
