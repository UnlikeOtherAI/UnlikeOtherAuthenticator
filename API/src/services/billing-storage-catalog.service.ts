import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { assertStripeObjectLivemode, requireStripeBillingEnabled, resolveStripeAccountContext,
  type StripeAccountContext } from './billing-stripe-client.service.js';

export const NESSIE_COMMERCIAL_PRICES = {
  EUR: { seat: 299n, storage: 999n }, GBP: { seat: 299n, storage: 849n }, USD: { seat: 399n, storage: 1099n },
} as const;

export async function verifyStoragePrice(stripe: Pick<Stripe, 'prices' | 'products'>,
  input: { priceId: string; currency: string; unitAmountMinor: bigint; product: string;
    account: StripeAccountContext }) {
  const price = await stripe.prices.retrieve(input.priceId);
  assertStripeObjectLivemode(price, input.account.livemode);
  const productId = typeof price.product === 'string' ? price.product : price.product.id;
  const product = await stripe.products.retrieve(productId);
  if ('deleted' in product && product.deleted) throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_PRODUCT_INVALID');
  assertStripeObjectLivemode(product, input.account.livemode);
  const metadata = { uoa_kind: 'storage_block', uoa_service: input.product,
    storage_block_bytes: '1000000000000', contract_version: '1' };
  const productMetadata = { uoa_kind: 'company_storage', uoa_service: input.product, contract_version: '1' };
  if (!price.active || !product.active || price.type !== 'recurring' ||
    price.billing_scheme !== 'per_unit' || price.transform_quantity !== null ||
    price.recurring?.meter || price.recurring?.trial_period_days ||
    price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== 'licensed' || price.currency.toUpperCase() !== input.currency ||
    price.unit_amount?.toString() !== input.unitAmountMinor.toString() ||
    price.lookup_key !== `uoa_${input.product}_storage_${input.currency.toLowerCase()}_tb_month_v1` ||
    JSON.stringify(Object.entries(price.metadata).sort()) !== JSON.stringify(Object.entries(metadata).sort()) ||
    JSON.stringify(Object.entries(product.metadata).sort()) !== JSON.stringify(Object.entries(productMetadata).sort())) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_CATALOG_DRIFT');
  }
  return { price, product };
}

export async function bindStorageCatalog(input: { serviceId: string; currency: 'EUR' | 'GBP' | 'USD';
  priceId: string; actor: LifecycleActor }, deps?: { prisma?: PrismaClient; stripe?: Stripe; livemode?: boolean }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const runtime = deps?.stripe ? { client: deps.stripe, livemode: deps.livemode ?? false } : requireStripeBillingEnabled();
  const stripe = runtime.client;
  const account = await resolveStripeAccountContext(stripe, deps?.livemode ?? runtime.livemode, prisma);
  const service = await prisma.billingService.findFirst({ where: { id: input.serviceId, identifier: 'nessie', active: true } });
  if (!service) throw new AppError('NOT_FOUND', 404);
  const amount = NESSIE_COMMERCIAL_PRICES[input.currency].storage;
  const verified = await verifyStoragePrice(stripe, { priceId: input.priceId,
    currency: input.currency, unitAmountMinor: amount, product: service.identifier, account });
  return prisma.$transaction(async (tx) => {
    const actorEmail = await requireLifecycleActor(tx as PrismaClient, input.actor);
    const row = await tx.billingStorageCatalog.upsert({ where: { serviceId_accountId_currency_version: {
      serviceId: service.id, accountId: account.id, currency: input.currency, version: 1,
    } }, create: { serviceId: service.id, accountId: account.id, currency: input.currency,
      unitAmountMinor: amount, stripeProductId: verified.product.id, stripePriceId: verified.price.id }, update: {} });
    if (row.stripePriceId !== input.priceId || row.unitAmountMinor !== amount ||
      row.stripeProductId !== verified.product.id) throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_CATALOG_DRIFT');
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'billing.storage_catalog_bound',
      metadata: { catalog_id: row.id, service_id: service.id, account_id: account.id,
        currency: input.currency, price_id: input.priceId } } });
    return { id: row.id, currency: row.currency, unit_amount_minor: row.unitAmountMinor.toString() };
  });
}
