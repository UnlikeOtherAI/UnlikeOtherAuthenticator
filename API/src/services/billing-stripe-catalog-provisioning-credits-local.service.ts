import {
  addCatalogAction,
  type CatalogDb,
  type CatalogProvisioningAction,
  differingFields,
  localCatalogDrift,
} from './billing-stripe-catalog-provisioning-local.shared.js';
import type { ValidatedStripeCommercialCatalog } from './billing-stripe-catalog-provisioning-remote.service.js';
import {
  CREDIT_AUTO_TOP_UP_OPTION_SPECS,
  CREDIT_PURCHASE_CURRENCIES,
  CREDIT_TOP_UP_SPECS,
  creditFundingPolicySpec,
  type CreditPurchaseCurrency,
  type CreditTopUpSpec,
} from './billing-stripe-catalog-provisioning-spec.js';

function assertCreditCatalogTerms(
  row: {
    id: string;
    key: string;
    version: number;
    currency: string;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
    stripeLookupKey: string;
    stripeProductId: string | null;
    stripePriceId: string | null;
  },
  spec: CreditTopUpSpec,
  remote: ValidatedStripeCommercialCatalog['creditPrices'][number],
): void {
  const fields = differingFields(row, {
    key: spec.catalogKey, version: spec.catalogVersion, currency: spec.currency,
    paymentAmountMinor: spec.paymentAmountMinor, creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
    stripeLookupKey: spec.stripeLookupKey,
  });
  if ((row.stripeProductId === null) !== (row.stripePriceId === null)) fields.push('partialStripeBinding');
  if (row.stripeProductId !== null && row.stripeProductId !== remote.stripeProductId) fields.push('stripeProductId');
  if (row.stripePriceId !== null && row.stripePriceId !== remote.stripePriceId) fields.push('stripePriceId');
  if (fields.length > 0) {
    localCatalogDrift('credit_catalog_terms', { catalog_id: row.id, catalog_key: spec.catalogKey, fields });
  }
}

export async function ensureProvisionedCreditCatalogs(params: {
  db: CatalogDb;
  accountId: string | null;
  catalog: ValidatedStripeCommercialCatalog;
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  if (!params.accountId) {
    for (const spec of CREDIT_TOP_UP_SPECS) {
      addCatalogAction(
        params.actions,
        'credit_catalog',
        `${spec.catalogKey}/v${spec.catalogVersion}`,
        true,
      );
    }
    return;
  }
  const rows = await params.db.billingCreditTopUpCatalog.findMany({
    where: { accountId: params.accountId },
  });
  for (const spec of CREDIT_TOP_UP_SPECS) {
    const remote = params.catalog.creditPrices.find(
      (price) => price.key === spec.catalogKey && price.version === spec.catalogVersion,
    );
    if (!remote) localCatalogDrift('credit_price_missing', { catalog_key: spec.catalogKey });
    const key = `${spec.catalogKey}/v${spec.catalogVersion}`;
    const row = rows.find(
      (candidate) => candidate.key === spec.catalogKey && candidate.version === spec.catalogVersion,
    );
    if (row) {
      assertCreditCatalogTerms(row, spec, remote);
      const incomplete = row.stripeProductId === null && row.stripePriceId === null;
      if (incomplete && params.write) {
        await params.db.billingCreditTopUpCatalog.update({
          where: { id: row.id },
          data: {
            stripeProductId: remote.stripeProductId,
            stripePriceId: remote.stripePriceId,
          },
        });
      }
      addCatalogAction(params.actions, 'credit_catalog', key, incomplete);
      continue;
    }
    const holder = rows.find((candidate) =>
      candidate.stripeLookupKey === remote.stripeLookupKey || candidate.stripePriceId === remote.stripePriceId);
    if (holder) {
      localCatalogDrift('credit_price_bound_elsewhere', { catalog_key: spec.catalogKey, holder_catalog_id: holder.id,
        holder_key: holder.key, holder_version: holder.version });
    }
    if (params.write) {
      await params.db.billingCreditTopUpCatalog.create({
        data: {
          accountId: params.accountId,
          key: spec.catalogKey,
          version: spec.catalogVersion,
          currency: spec.currency,
          paymentAmountMinor: spec.paymentAmountMinor,
          creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
          stripeLookupKey: spec.stripeLookupKey,
          stripeProductId: remote.stripeProductId,
          stripePriceId: remote.stripePriceId,
        },
      });
    }
    addCatalogAction(params.actions, 'credit_catalog', key, true);
  }
}

async function ensureCreditPolicy(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  currency: CreditPurchaseCurrency;
  write: boolean;
  actions: CatalogProvisioningAction[];
}) {
  const spec = creditFundingPolicySpec(params.currency);
  const rows = await params.db.billingCreditFundingPolicy.findMany({
    where: { serviceId: params.service.id, currency: params.currency },
  });
  const active = rows.filter((row) => row.active);
  const existing = active[0];
  if (active.length > 1) {
    localCatalogDrift('credit_policy_multiple_active', { service: params.service.identifier,
      currency: params.currency, policy_ids: active.map((row) => row.id) });
  }
  const key = `${params.service.identifier}/${params.currency}/v${spec.version}`;
  if (existing) {
    const fields = differingFields(existing, { ...spec, deactivatedAt: null });
    if (fields.length > 0) {
      localCatalogDrift('credit_policy_terms', { service: params.service.identifier, policy_id: existing.id, fields });
    }
    addCatalogAction(params.actions, 'credit_funding_policy', key, false);
    return existing;
  }
  const inactive = rows.find((row) => row.version === spec.version);
  if (inactive) {
    localCatalogDrift('credit_policy_version_inactive', { service: params.service.identifier,
      currency: params.currency, policy_id: inactive.id });
  }
  const created = params.write
    ? await params.db.billingCreditFundingPolicy.create({
        data: { serviceId: params.service.id, ...spec },
      })
    : null;
  addCatalogAction(params.actions, 'credit_funding_policy', key, true);
  return created;
}

function assertOfferTerms(
  offer: {
    id: string;
    serviceId: string;
    key: string;
    version: number;
    catalogKey: string;
    catalogVersion: number;
    name: string;
    description: string;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
    automaticTopUpEligible: boolean;
    active: boolean;
    deactivatedAt: Date | null;
  },
  serviceId: string,
  spec: CreditTopUpSpec,
): void {
  const fields = differingFields(offer, {
    serviceId, key: spec.key, version: spec.version, catalogKey: spec.catalogKey,
    catalogVersion: spec.catalogVersion, name: spec.name, description: spec.description,
    paymentAmountMinor: spec.paymentAmountMinor, creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
    automaticTopUpEligible: true, active: true, deactivatedAt: null,
  });
  if (fields.length > 0) localCatalogDrift('credit_offer_terms', { offer_id: offer.id, offer_key: spec.key, fields });
}

async function ensureCreditOffersAndOption(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  currency: CreditPurchaseCurrency;
  policy: { id: string } | null;
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  const specs = CREDIT_TOP_UP_SPECS.filter((spec) => spec.currency === params.currency);
  if (!params.policy) {
    for (const spec of specs) {
      addCatalogAction(
        params.actions,
        'credit_top_up_offer',
        `${params.service.identifier}/${spec.key}/v1`,
        true,
      );
    }
    for (const option of CREDIT_AUTO_TOP_UP_OPTION_SPECS.filter((spec) => spec.currency === params.currency)) {
      addCatalogAction(params.actions, 'credit_auto_top_up_option',
        `${params.service.identifier}/${option.key}/v${option.version}`, true);
    }
    return;
  }
  const offers = await params.db.billingCreditTopUpOffer.findMany({
    where: { policyId: params.policy.id },
  });
  const unknown = offers.filter((offer) => offer.active && !specs.some((s) => s.key === offer.key));
  if (unknown.length > 0) {
    localCatalogDrift('credit_offer_unknown_active', { service: params.service.identifier,
      policy_id: params.policy.id, offer_ids: unknown.map((offer) => offer.id) });
  }
  const resolved = new Map<string, { id: string }>();
  for (const spec of specs) {
    const key = `${params.service.identifier}/${spec.key}/v${spec.version}`;
    let offer = offers.find(
      (candidate) => candidate.key === spec.key && candidate.version === spec.version,
    );
    if (offer) {
      assertOfferTerms(offer, params.service.id, spec);
      addCatalogAction(params.actions, 'credit_top_up_offer', key, false);
    } else {
      const other = offers.find((candidate) => candidate.active && candidate.key === spec.key);
      if (other) {
        localCatalogDrift('credit_offer_other_version_active', { offer_id: other.id, offer_key: spec.key,
          version: other.version });
      }
      if (params.write) {
        offer = await params.db.billingCreditTopUpOffer.create({
          data: {
            policyId: params.policy.id,
            serviceId: params.service.id,
            key: spec.key,
            version: spec.version,
            catalogKey: spec.catalogKey,
            catalogVersion: spec.catalogVersion,
            name: spec.name,
            description: spec.description,
            paymentAmountMinor: spec.paymentAmountMinor,
            creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
            automaticTopUpEligible: true,
          },
        });
      }
      addCatalogAction(params.actions, 'credit_top_up_offer', key, true);
    }
    if (offer) resolved.set(spec.key, offer);
  }
  await ensureCreditAutoTopUpOptions({ ...params, policy: params.policy, offers: resolved });
}

async function ensureCreditAutoTopUpOptions(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  currency: CreditPurchaseCurrency;
  policy: { id: string };
  offers: Map<string, { id: string }>;
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  const specs = CREDIT_AUTO_TOP_UP_OPTION_SPECS.filter((spec) => spec.currency === params.currency);
  const options = await params.db.billingCreditAutoTopUpOption.findMany({
    where: { policyId: params.policy.id },
  });
  const unknownOptions = options.filter((option) => option.active && !specs.some((spec) => spec.key === option.key));
  if (unknownOptions.length > 0) {
    localCatalogDrift('credit_option_unknown_active', { service: params.service.identifier,
      option_ids: unknownOptions.map((option) => option.id) });
  }
  for (const spec of specs) {
    const key = `${params.service.identifier}/${spec.key}/v${spec.version}`;
    const refillOffer = params.offers.get(spec.refillOfferKey);
    const option = options.find((candidate) => candidate.key === spec.key && candidate.version === spec.version);
    if (option) {
      const fields = differingFields(option, {
        active: true, deactivatedAt: null, serviceId: params.service.id, refillOfferId: refillOffer?.id,
        thresholdMicrocredits: spec.thresholdMicrocredits, thresholdAmountMinor: spec.thresholdAmountMinor,
        monthlyChargeCapMinor: spec.monthlyChargeCapMinor,
      });
      if (fields.length > 0) localCatalogDrift('credit_option_terms', { option_id: option.id, fields });
      addCatalogAction(params.actions, 'credit_auto_top_up_option', key, false);
      continue;
    }
    const otherOption = options.find((candidate) => candidate.active && candidate.key === spec.key);
    if (otherOption) {
      localCatalogDrift('credit_option_other_version_active', { option_id: otherOption.id,
        version: otherOption.version });
    }
    if (params.write) {
      if (!refillOffer) {
        localCatalogDrift('credit_option_refill_offer_missing', { service: params.service.identifier,
          offer_key: spec.refillOfferKey });
      }
      await params.db.billingCreditAutoTopUpOption.create({
        data: {
          policyId: params.policy.id,
          serviceId: params.service.id,
          refillOfferId: refillOffer.id,
          key: spec.key,
          version: spec.version,
          thresholdMicrocredits: spec.thresholdMicrocredits,
          thresholdAmountMinor: spec.thresholdAmountMinor,
          monthlyChargeCapMinor: spec.monthlyChargeCapMinor,
        },
      });
    }
    addCatalogAction(params.actions, 'credit_auto_top_up_option', key, true);
  }
}

export async function ensureProvisionedServiceCredits(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  for (const currency of CREDIT_PURCHASE_CURRENCIES) {
    const policy = await ensureCreditPolicy({ ...params, currency });
    await ensureCreditOffersAndOption({ ...params, currency, policy });
  }
}
