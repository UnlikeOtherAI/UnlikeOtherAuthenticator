import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { ensureProvisionedCreditCatalogs } from './billing-stripe-catalog-provisioning-credits-local.service.js';
import { differingFields, localCatalogDrift, type CatalogProvisioningAction } from './billing-stripe-catalog-provisioning-local.shared.js';
import { validateCreditPrice, type StripeCatalogProvisioningClient, type ValidatedCreditPrice } from './billing-stripe-catalog-provisioning-remote.service.js';
import { CREDIT_PURCHASE_CURRENCIES, CREDIT_TOP_UP_SPECS, NESSIE_MANUAL_TOP_UP_SPECS, creditPriceMetadata } from './billing-stripe-catalog-provisioning-spec.js';

/** Publish the manual storefront separately from existing customers' reload agreements. */
export async function provisionNessieTopUps(params: {
  stripe: StripeCatalogProvisioningClient; prisma: PrismaClient; expectedStripeAccountId: string;
  expectedLivemode: boolean; dryRun: boolean;
}) {
  const { stripe, prisma, expectedLivemode, dryRun } = params;
  const remoteAccount = await stripe.accounts.retrieveCurrent();
  if (remoteAccount.id !== params.expectedStripeAccountId) {
    throw new AppError('INTERNAL', 409, 'STRIPE_COMMERCIAL_CATALOG_ACCOUNT_MISMATCH');
  }
  const account = await prisma.billingStripeAccount.findUniqueOrThrow({
    where: { stripeAccountId_livemode: { stripeAccountId: remoteAccount.id, livemode: expectedLivemode } },
  });
  const service = await prisma.billingService.findFirstOrThrow({ where: { identifier: 'nessie', active: true } });
  const basis = CREDIT_TOP_UP_SPECS.find((spec) => spec.key === 'credits_usd_10');
  if (!basis) localCatalogDrift('credit_product_basis_missing');
  const binding = await prisma.billingCreditTopUpCatalog.findUniqueOrThrow({
    where: { accountId_key_version: { accountId: account.id, key: basis.catalogKey, version: basis.catalogVersion } },
  });
  if (!binding.stripeProductId || !binding.stripePriceId) localCatalogDrift('credit_product_unbound');
  const product = await stripe.products.retrieve(binding.stripeProductId);
  if ('deleted' in product || !product.active) localCatalogDrift('credit_product_inactive');
  validateCreditPrice({ price: await stripe.prices.retrieve(binding.stripePriceId), product, expectedLivemode, spec: basis });
  const remote = new Map<string, Stripe.Price>();
  for (let offset = 0; offset < NESSIE_MANUAL_TOP_UP_SPECS.length; offset += 10) {
    const lookupKeys = NESSIE_MANUAL_TOP_UP_SPECS.slice(offset, offset + 10).map((spec) => spec.stripeLookupKey);
    const page = await stripe.prices.list({ lookup_keys: lookupKeys, limit: 100 });
    if (page.has_more) localCatalogDrift('credit_price_list_incomplete');
    for (const price of page.data) {
      if (!price.lookup_key || !lookupKeys.includes(price.lookup_key) || remote.has(price.lookup_key)) {
        localCatalogDrift('credit_price_lookup_conflict');
      }
      remote.set(price.lookup_key, price);
    }
  }
  const creditPrices: ValidatedCreditPrice[] = [];
  const missing = NESSIE_MANUAL_TOP_UP_SPECS.filter((spec) => !remote.has(spec.stripeLookupKey));
  for (const spec of NESSIE_MANUAL_TOP_UP_SPECS) {
    const price = remote.get(spec.stripeLookupKey);
    if (price) creditPrices.push(validateCreditPrice({ price, product, expectedLivemode, spec }));
  }
  if (!dryRun) {
    for (const spec of missing) {
      const price = await stripe.prices.create({
        product: product.id, currency: spec.currency.toLowerCase(), unit_amount: Number(spec.paymentAmountMinor),
        lookup_key: spec.stripeLookupKey, metadata: creditPriceMetadata(spec),
      }, { idempotencyKey: `nessie-manual-top-up:${product.id}:${spec.stripeLookupKey}` });
      creditPrices.push(validateCreditPrice({ price, product, expectedLivemode, spec }));
    }
  }
  const actions: CatalogProvisioningAction[] = [];
  await prisma.$transaction(async (tx) => {
    await ensureProvisionedCreditCatalogs({
      db: tx, accountId: account.id, catalog: { creditPrices }, actions, write: !dryRun,
      specs: NESSIE_MANUAL_TOP_UP_SPECS.filter((spec) => creditPrices.some((entry) => entry.key === spec.catalogKey)),
    });
    for (const currency of CREDIT_PURCHASE_CURRENCIES) {
      const policies = await tx.billingCreditFundingPolicy.findMany({ where: { serviceId: service.id, currency, active: true } });
      if (policies.length !== 1 || !policies[0].topUpEnabled) localCatalogDrift('credit_funding_policy_unavailable', { currency });
      const policy = policies[0];
      const offers = await tx.billingCreditTopUpOffer.findMany({ where: { policyId: policy.id } });
      const desired = NESSIE_MANUAL_TOP_UP_SPECS.filter((spec) => spec.currency === currency);
      for (const spec of desired) {
        const row = offers.find((entry) => entry.key === spec.key && entry.version === spec.version);
        const terms = { serviceId: service.id, catalogKey: spec.catalogKey, catalogVersion: spec.catalogVersion,
          paymentAmountMinor: spec.paymentAmountMinor, creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits };
        if (row) {
          const fields = differingFields(row, { ...terms, active: true, deactivatedAt: null });
          if (fields.length) localCatalogDrift('credit_offer_terms', { offer_id: row.id, fields });
          if (row.manualPurchaseEnabled) continue;
          if (!dryRun) await tx.billingCreditTopUpOffer.update({ where: { id: row.id }, data: { manualPurchaseEnabled: true } });
        } else {
          if (offers.some((entry) => entry.key === spec.key && entry.active)) localCatalogDrift('credit_offer_other_version_active');
          if (!dryRun) await tx.billingCreditTopUpOffer.create({ data: {
            ...terms, policyId: policy.id, key: spec.key, version: spec.version,
            name: spec.name, description: spec.description,
            automaticTopUpEligible: CREDIT_TOP_UP_SPECS.some((standard) => standard.key === spec.key),
          } });
        }
        actions.push({ resource: 'manual_top_up_offer', key: spec.key, outcome: 'created' });
      }
      for (const row of offers.filter((entry) => entry.active && entry.manualPurchaseEnabled &&
        CREDIT_TOP_UP_SPECS.some((spec) => spec.key === entry.key && spec.version === entry.version) &&
        !desired.some((spec) => spec.key === entry.key))) {
        if (!dryRun) await tx.billingCreditTopUpOffer.update({ where: { id: row.id }, data: { manualPurchaseEnabled: false } });
        actions.push({ resource: 'manual_top_up_offer', key: row.key, outcome: 'retired' });
      }
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  return { mode: dryRun ? 'dry-run' : 'apply', account_id: remoteAccount.id, livemode: expectedLivemode,
    stripe_prices_to_create: missing.map((spec) => spec.stripeLookupKey), actions };
}
