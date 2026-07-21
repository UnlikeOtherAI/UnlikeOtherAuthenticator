import {
  addCatalogAction,
  type CatalogDb,
  type CatalogProvisioningAction,
  localCatalogDrift,
} from './billing-stripe-catalog-provisioning-local.shared.js';
import type { ValidatedStripeCommercialCatalog } from './billing-stripe-catalog-provisioning-remote.service.js';
import {
  CREDIT_AUTO_TOP_UP_SPEC,
  CREDIT_FUNDING_POLICY_SPEC,
  CREDIT_TOP_UP_SPECS,
  type CreditTopUpSpec,
} from './billing-stripe-catalog-provisioning-spec.js';

function assertCreditCatalogTerms(
  row: {
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
  if (
    row.key !== spec.catalogKey ||
    row.version !== spec.catalogVersion ||
    row.currency !== CREDIT_FUNDING_POLICY_SPEC.currency ||
    row.paymentAmountMinor !== spec.paymentAmountMinor ||
    row.creditsReceivedMicrocredits !== spec.creditsReceivedMicrocredits ||
    row.stripeLookupKey !== spec.stripeLookupKey ||
    (row.stripeProductId === null) !== (row.stripePriceId === null) ||
    (row.stripeProductId !== null && row.stripeProductId !== remote.stripeProductId) ||
    (row.stripePriceId !== null && row.stripePriceId !== remote.stripePriceId)
  ) {
    localCatalogDrift();
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
    if (!remote) localCatalogDrift();
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
    if (
      rows.some(
        (candidate) =>
          candidate.stripeLookupKey === remote.stripeLookupKey ||
          candidate.stripePriceId === remote.stripePriceId,
      )
    ) {
      localCatalogDrift();
    }
    if (params.write) {
      await params.db.billingCreditTopUpCatalog.create({
        data: {
          accountId: params.accountId,
          key: spec.catalogKey,
          version: spec.catalogVersion,
          currency: CREDIT_FUNDING_POLICY_SPEC.currency,
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
  write: boolean;
  actions: CatalogProvisioningAction[];
}) {
  const rows = await params.db.billingCreditFundingPolicy.findMany({
    where: { serviceId: params.service.id },
  });
  const active = rows.filter((row) => row.active);
  const existing = active[0];
  if (active.length > 1) localCatalogDrift();
  const key = `${params.service.identifier}/USD/v${CREDIT_FUNDING_POLICY_SPEC.version}`;
  if (existing) {
    if (
      existing.version !== CREDIT_FUNDING_POLICY_SPEC.version ||
      existing.currency !== CREDIT_FUNDING_POLICY_SPEC.currency ||
      existing.topUpEnabled !== CREDIT_FUNDING_POLICY_SPEC.topUpEnabled ||
      existing.automaticTopUpEnabled !== CREDIT_FUNDING_POLICY_SPEC.automaticTopUpEnabled ||
      existing.automaticConsentVersion !== CREDIT_FUNDING_POLICY_SPEC.automaticConsentVersion ||
      existing.deactivatedAt !== null
    ) {
      localCatalogDrift();
    }
    addCatalogAction(params.actions, 'credit_funding_policy', key, false);
    return existing;
  }
  if (
    rows.some(
      (row) =>
        row.version === CREDIT_FUNDING_POLICY_SPEC.version &&
        row.currency === CREDIT_FUNDING_POLICY_SPEC.currency,
    )
  ) {
    localCatalogDrift();
  }
  const created = params.write
    ? await params.db.billingCreditFundingPolicy.create({
        data: { serviceId: params.service.id, ...CREDIT_FUNDING_POLICY_SPEC },
      })
    : null;
  addCatalogAction(params.actions, 'credit_funding_policy', key, true);
  return created;
}

function assertOfferTerms(
  offer: {
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
  if (
    offer.serviceId !== serviceId ||
    offer.key !== spec.key ||
    offer.version !== spec.version ||
    offer.catalogKey !== spec.catalogKey ||
    offer.catalogVersion !== spec.catalogVersion ||
    offer.name !== spec.name ||
    offer.description !== spec.description ||
    offer.paymentAmountMinor !== spec.paymentAmountMinor ||
    offer.creditsReceivedMicrocredits !== spec.creditsReceivedMicrocredits ||
    !offer.automaticTopUpEligible ||
    !offer.active ||
    offer.deactivatedAt !== null
  ) {
    localCatalogDrift();
  }
}

async function ensureCreditOffersAndOption(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  policy: { id: string } | null;
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  if (!params.policy) {
    for (const spec of CREDIT_TOP_UP_SPECS) {
      addCatalogAction(
        params.actions,
        'credit_top_up_offer',
        `${params.service.identifier}/${spec.key}/v1`,
        true,
      );
    }
    addCatalogAction(
      params.actions,
      'credit_auto_top_up_option',
      `${params.service.identifier}/default/v1`,
      true,
    );
    return;
  }
  const offers = await params.db.billingCreditTopUpOffer.findMany({
    where: { policyId: params.policy.id },
  });
  if (
    offers.some((offer) => offer.active && !CREDIT_TOP_UP_SPECS.some((s) => s.key === offer.key))
  ) {
    localCatalogDrift();
  }
  const resolved = new Map<string, { id: string }>();
  for (const spec of CREDIT_TOP_UP_SPECS) {
    const key = `${params.service.identifier}/${spec.key}/v${spec.version}`;
    let offer = offers.find(
      (candidate) => candidate.key === spec.key && candidate.version === spec.version,
    );
    if (offer) {
      assertOfferTerms(offer, params.service.id, spec);
      addCatalogAction(params.actions, 'credit_top_up_offer', key, false);
    } else {
      if (offers.some((candidate) => candidate.active && candidate.key === spec.key)) {
        localCatalogDrift();
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

  const options = await params.db.billingCreditAutoTopUpOption.findMany({
    where: { policyId: params.policy.id },
  });
  if (options.some((option) => option.active && option.key !== CREDIT_AUTO_TOP_UP_SPEC.key)) {
    localCatalogDrift();
  }
  const option = options.find(
    (candidate) =>
      candidate.key === CREDIT_AUTO_TOP_UP_SPEC.key &&
      candidate.version === CREDIT_AUTO_TOP_UP_SPEC.version,
  );
  const refillOffer = resolved.get(CREDIT_AUTO_TOP_UP_SPEC.refillOfferKey);
  if (option) {
    if (
      !option.active ||
      option.deactivatedAt !== null ||
      option.serviceId !== params.service.id ||
      option.refillOfferId !== refillOffer?.id ||
      option.thresholdMicrocredits !== CREDIT_AUTO_TOP_UP_SPEC.thresholdMicrocredits ||
      option.monthlyChargeCapMinor !== CREDIT_AUTO_TOP_UP_SPEC.monthlyChargeCapMinor
    ) {
      localCatalogDrift();
    }
    addCatalogAction(
      params.actions,
      'credit_auto_top_up_option',
      `${params.service.identifier}/default/v1`,
      false,
    );
    return;
  }
  if (
    options.some((candidate) => candidate.active && candidate.key === CREDIT_AUTO_TOP_UP_SPEC.key)
  ) {
    localCatalogDrift();
  }
  if (params.write) {
    if (!refillOffer) localCatalogDrift();
    await params.db.billingCreditAutoTopUpOption.create({
      data: {
        policyId: params.policy.id,
        serviceId: params.service.id,
        refillOfferId: refillOffer.id,
        key: CREDIT_AUTO_TOP_UP_SPEC.key,
        version: CREDIT_AUTO_TOP_UP_SPEC.version,
        thresholdMicrocredits: CREDIT_AUTO_TOP_UP_SPEC.thresholdMicrocredits,
        monthlyChargeCapMinor: CREDIT_AUTO_TOP_UP_SPEC.monthlyChargeCapMinor,
      },
    });
  }
  addCatalogAction(
    params.actions,
    'credit_auto_top_up_option',
    `${params.service.identifier}/default/v1`,
    true,
  );
}

export async function ensureProvisionedServiceCredits(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  const policy = await ensureCreditPolicy(params);
  await ensureCreditOffersAndOption({ ...params, policy });
}
