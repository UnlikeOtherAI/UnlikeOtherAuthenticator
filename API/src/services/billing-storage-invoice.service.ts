import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode, type StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { verifyStoragePrice } from './billing-storage-catalog.service.js';
type StorageBinding = NonNullable<Awaited<ReturnType<typeof storageBinding>>>;
export async function storageBinding(metadata: Stripe.Metadata | null | undefined, account: StripeAccountContext, prisma: PrismaClient) {
  if (!metadata?.uoa_storage_attempt_id) return null;
  const attempt = await prisma.billingStoragePaymentAttempt.findUnique({ where: { id: metadata.uoa_storage_attempt_id } });
  const expansion = attempt ? await prisma.billingStorageExpansion.findUnique({ where: { id: attempt.expansionId } }) : null;
  const mandate = attempt ? await prisma.billingStorageMandate.findUnique({ where: { id: attempt.mandateId } }) : null;
  const catalog = mandate ? await prisma.billingStorageCatalog.findUnique({ where: { id: mandate.catalogId } }) : null;
  if (!attempt || !expansion || !mandate || !catalog || mandate.accountId !== account.id || catalog.accountId !== account.id ||
    metadata.uoa_storage_expansion_id !== expansion.id || metadata.uoa_storage_mandate_id !== mandate.id || metadata.uoa_service !== 'nessie') {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_WEBHOOK_BINDING_INVALID');
  }
  return { attempt, expansion, mandate, catalog };
}

export function assertStorageSubscription(binding: StorageBinding, remote: Stripe.Subscription, account: StripeAccountContext) {
  assertStripeObjectLivemode(remote, account.livemode);
  const item = remote.items.data[0];
  if (!item || remote.items.data.length !== 1 || item.price.id !== binding.catalog.stripePriceId ||
    remote.collection_method !== 'charge_automatically' ||
    stripeExternalId(remote.customer) !== binding.mandate.stripeCustomerId ||
    (binding.attempt.stripeSubscriptionId && remote.id !== binding.attempt.stripeSubscriptionId) ||
    remote.discounts.length || item.discounts.length) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SUBSCRIPTION_DRIFT');
  }
  return item;
}

/** One verified price/customer/subscription binding for recovery and payment evidence. */
export async function readBoundStorageInvoice(invoiceId: string, stripe: Stripe,
  account: StripeAccountContext, prisma: PrismaClient, expected?: StorageBinding) {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  assertStripeObjectLivemode(invoice, account.livemode);
  const binding = expected ?? await storageBinding(invoice.parent?.subscription_details?.metadata, account, prisma);
  if (!binding) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_INVOICE_UNBOUND');
  const currentBinding = await storageBinding(invoice.parent?.subscription_details?.metadata, account, prisma);
  const subscriptionId = stripeExternalId(invoice.parent?.subscription_details?.subscription);
  if (!currentBinding || currentBinding.attempt.id !== binding.attempt.id || !subscriptionId ||
    invoice.id !== invoiceId || stripeExternalId(invoice.customer) !== binding.mandate.stripeCustomerId ||
    invoice.currency.toUpperCase() !== binding.catalog.currency || invoice.collection_method !== 'charge_automatically' ||
    invoice.discounts.length || invoice.lines.has_more || !invoice.lines.data.length) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_INVOICE_DRIFT');
  }
  await verifyStoragePrice(stripe, { priceId: binding.catalog.stripePriceId, currency: binding.catalog.currency,
    unitAmountMinor: binding.catalog.unitAmountMinor, product: 'nessie', account });
  const remote = await stripe.subscriptions.retrieve(subscriptionId);
  const item = assertStorageSubscription(binding, remote, account);
  if (invoice.lines.data.some((line) => stripeExternalId(line.pricing?.price_details?.price) !== binding.catalog.stripePriceId ||
    line.parent?.subscription_item_details?.subscription_item !== item.id ||
    line.currency.toUpperCase() !== binding.catalog.currency || line.discounts.length ||
    ![binding.expansion.fromBlocks, binding.expansion.toBlocks].includes(line.quantity ?? -1))) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_INVOICE_LINES_INVALID');
  }
  if (invoice.billing_reason !== 'subscription_update' && (invoice.lines.data.length !== 1 ||
    invoice.lines.data[0]!.amount !== Number(binding.catalog.unitAmountMinor) * binding.expansion.toBlocks ||
    invoice.lines.data[0]!.parent?.subscription_item_details?.proration)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_RECURRING_AMOUNT_INVALID');
  }
  if (invoice.lines.data.some((line) => !Number.isSafeInteger(line.period.start) || !Number.isSafeInteger(line.period.end) ||
    line.period.end <= line.period.start)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_INVOICE_PERIOD_INVALID');
  }
  return { binding, invoice, remote };
}
