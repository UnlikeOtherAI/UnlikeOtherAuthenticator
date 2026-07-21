import { BillingRecurringAddonEntitlementScope } from '@prisma/client';

import {
  ensureProvisionedCreditCatalogs,
  ensureProvisionedServiceCredits,
} from './billing-stripe-catalog-provisioning-credits-local.service.js';
import {
  addCatalogAction,
  type CatalogDb,
  type CatalogProvisioningAction,
  localCatalogDrift,
  sameCatalogStrings,
} from './billing-stripe-catalog-provisioning-local.shared.js';
import type { ValidatedStripeCommercialCatalog } from './billing-stripe-catalog-provisioning-remote.service.js';
import {
  DEEPWATER_PRIVACY_SPEC,
  PROVISIONED_BILLING_SERVICE_IDENTIFIERS,
} from './billing-stripe-catalog-provisioning-spec.js';

export type { CatalogProvisioningAction } from './billing-stripe-catalog-provisioning-local.shared.js';

async function requireServices(db: CatalogDb) {
  const services = await db.billingService.findMany({
    where: { active: true },
    select: { id: true, identifier: true, name: true, active: true },
  });
  if (
    !sameCatalogStrings(
      services.map((service) => service.identifier),
      PROVISIONED_BILLING_SERVICE_IDENTIFIERS,
    )
  ) {
    localCatalogDrift();
  }
  return new Map(services.map((service) => [service.identifier, service]));
}

async function requireDeepWaterApp(db: CatalogDb) {
  const apps = await db.app.findMany({
    where: { identifier: DEEPWATER_PRIVACY_SPEC.appIdentifier, active: true },
    select: { id: true, identifier: true, featureFlagsEnabled: true },
  });
  if (apps.length !== 1 || !apps[0]?.featureFlagsEnabled) localCatalogDrift();
  return apps[0];
}

async function ensureFeatureFlag(params: {
  db: CatalogDb;
  appId: string;
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  const key = `${DEEPWATER_PRIVACY_SPEC.appIdentifier}/${DEEPWATER_PRIVACY_SPEC.featureFlagKey}`;
  const existing = await params.db.featureFlagDefinition.findUnique({
    where: {
      appId_key: { appId: params.appId, key: DEEPWATER_PRIVACY_SPEC.featureFlagKey },
    },
  });
  if (existing) {
    if (
      existing.defaultState ||
      existing.description !== DEEPWATER_PRIVACY_SPEC.featureFlagDescription
    ) {
      localCatalogDrift();
    }
    addCatalogAction(params.actions, 'feature_flag', key, false);
    return;
  }
  if (params.write) {
    await params.db.featureFlagDefinition.create({
      data: {
        appId: params.appId,
        key: DEEPWATER_PRIVACY_SPEC.featureFlagKey,
        description: DEEPWATER_PRIVACY_SPEC.featureFlagDescription,
        defaultState: false,
      },
    });
  }
  addCatalogAction(params.actions, 'feature_flag', key, true);
}

async function ensureStripeAccount(params: {
  db: CatalogDb;
  catalog: ValidatedStripeCommercialCatalog;
  write: boolean;
  actions: CatalogProvisioningAction[];
}) {
  const key = `${params.catalog.stripeAccountId}/${params.catalog.livemode ? 'live' : 'test'}`;
  let account = await params.db.billingStripeAccount.findUnique({
    where: {
      stripeAccountId_livemode: {
        stripeAccountId: params.catalog.stripeAccountId,
        livemode: params.catalog.livemode,
      },
    },
  });
  const missing = !account;
  if (missing && params.write) {
    account = await params.db.billingStripeAccount.create({
      data: {
        stripeAccountId: params.catalog.stripeAccountId,
        livemode: params.catalog.livemode,
      },
    });
  }
  addCatalogAction(params.actions, 'stripe_account', key, missing);
  return account;
}

async function ensureRecurringAddon(params: {
  db: CatalogDb;
  deepwater: { id: string };
  appId: string;
  accountId: string | null;
  remote: ValidatedStripeCommercialCatalog['recurringAddon'];
  write: boolean;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  const offers = await params.db.billingRecurringAddonOffer.findMany({
    where: { serviceId: params.deepwater.id, key: DEEPWATER_PRIVACY_SPEC.key },
  });
  let offer = offers.find((candidate) => candidate.version === DEEPWATER_PRIVACY_SPEC.version);
  if (offer) {
    if (
      !offer.active ||
      offer.deactivatedAt !== null ||
      offer.name !== DEEPWATER_PRIVACY_SPEC.name ||
      offer.description !== DEEPWATER_PRIVACY_SPEC.description ||
      !sameCatalogStrings(offer.benefits, DEEPWATER_PRIVACY_SPEC.benefits) ||
      offer.monthlyAmountMinor !== DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor ||
      offer.currency !== DEEPWATER_PRIVACY_SPEC.currency
    ) {
      localCatalogDrift();
    }
    addCatalogAction(params.actions, 'recurring_addon_offer', 'deepwater/privacy/v1', false);
  } else {
    if (offers.some((candidate) => candidate.active)) localCatalogDrift();
    if (params.write) {
      offer = await params.db.billingRecurringAddonOffer.create({
        data: {
          serviceId: params.deepwater.id,
          key: DEEPWATER_PRIVACY_SPEC.key,
          version: DEEPWATER_PRIVACY_SPEC.version,
          name: DEEPWATER_PRIVACY_SPEC.name,
          description: DEEPWATER_PRIVACY_SPEC.description,
          benefits: [...DEEPWATER_PRIVACY_SPEC.benefits],
          monthlyAmountMinor: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor,
          currency: DEEPWATER_PRIVACY_SPEC.currency,
        },
      });
    }
    addCatalogAction(params.actions, 'recurring_addon_offer', 'deepwater/privacy/v1', true);
  }
  if (!offer) {
    addCatalogAction(
      params.actions,
      'recurring_addon_feature_policy',
      'deepwater/privacy/team',
      true,
    );
    addCatalogAction(params.actions, 'recurring_addon_catalog', 'deepwater/privacy/v1', true);
    return;
  }

  const policies = await params.db.billingRecurringAddonFeaturePolicy.findMany({
    where: { offerId: offer.id },
  });
  const expectedPolicy = policies.find(
    (policy) =>
      policy.appId === params.appId &&
      policy.featureFlagKey === DEEPWATER_PRIVACY_SPEC.featureFlagKey &&
      policy.entitlementScope === BillingRecurringAddonEntitlementScope.TEAM,
  );
  if (expectedPolicy) {
    if (!expectedPolicy.active || expectedPolicy.serviceId !== params.deepwater.id) {
      localCatalogDrift();
    }
    if (policies.some((policy) => policy.active && policy.id !== expectedPolicy.id)) {
      localCatalogDrift();
    }
    addCatalogAction(
      params.actions,
      'recurring_addon_feature_policy',
      'deepwater/privacy/team',
      false,
    );
  } else {
    if (policies.some((policy) => policy.active)) localCatalogDrift();
    if (params.write) {
      await params.db.billingRecurringAddonFeaturePolicy.create({
        data: {
          serviceId: params.deepwater.id,
          offerId: offer.id,
          appId: params.appId,
          featureFlagKey: DEEPWATER_PRIVACY_SPEC.featureFlagKey,
          entitlementScope: BillingRecurringAddonEntitlementScope.TEAM,
        },
      });
    }
    addCatalogAction(
      params.actions,
      'recurring_addon_feature_policy',
      'deepwater/privacy/team',
      true,
    );
  }

  if (!params.accountId) {
    addCatalogAction(params.actions, 'recurring_addon_catalog', 'deepwater/privacy/v1', true);
    return;
  }
  const catalogs = await params.db.billingRecurringAddonCatalog.findMany({
    where: { accountId: params.accountId },
  });
  const row = catalogs.find((catalog) => catalog.offerId === offer.id);
  if (row) {
    if (
      row.serviceId !== params.deepwater.id ||
      row.currency !== DEEPWATER_PRIVACY_SPEC.currency ||
      row.monthlyAmountMinor !== DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor ||
      row.stripeLookupKey !== params.remote.stripeLookupKey ||
      (row.stripeProductId === null) !== (row.stripePriceId === null) ||
      (row.stripeProductId !== null && row.stripeProductId !== params.remote.stripeProductId) ||
      (row.stripePriceId !== null && row.stripePriceId !== params.remote.stripePriceId)
    ) {
      localCatalogDrift();
    }
    const incomplete = row.stripeProductId === null && row.stripePriceId === null;
    if (incomplete && params.write) {
      await params.db.billingRecurringAddonCatalog.update({
        where: { id: row.id },
        data: {
          stripeProductId: params.remote.stripeProductId,
          stripePriceId: params.remote.stripePriceId,
        },
      });
    }
    addCatalogAction(params.actions, 'recurring_addon_catalog', 'deepwater/privacy/v1', incomplete);
    return;
  }
  if (
    catalogs.some(
      (catalog) =>
        catalog.stripeLookupKey === params.remote.stripeLookupKey ||
        catalog.stripeProductId === params.remote.stripeProductId ||
        catalog.stripePriceId === params.remote.stripePriceId,
    )
  ) {
    localCatalogDrift();
  }
  if (params.write) {
    await params.db.billingRecurringAddonCatalog.create({
      data: {
        accountId: params.accountId,
        serviceId: params.deepwater.id,
        offerId: offer.id,
        currency: DEEPWATER_PRIVACY_SPEC.currency,
        monthlyAmountMinor: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor,
        stripeLookupKey: params.remote.stripeLookupKey,
        stripeProductId: params.remote.stripeProductId,
        stripePriceId: params.remote.stripePriceId,
      },
    });
  }
  addCatalogAction(params.actions, 'recurring_addon_catalog', 'deepwater/privacy/v1', true);
}

export async function reconcileLocalStripeCommercialCatalog(params: {
  db: CatalogDb;
  catalog: ValidatedStripeCommercialCatalog;
  write: boolean;
}): Promise<CatalogProvisioningAction[]> {
  const actions: CatalogProvisioningAction[] = [];
  const services = await requireServices(params.db);
  const app = await requireDeepWaterApp(params.db);
  await ensureFeatureFlag({ db: params.db, appId: app.id, write: params.write, actions });
  const account = await ensureStripeAccount({ ...params, actions });
  await ensureProvisionedCreditCatalogs({
    ...params,
    accountId: account?.id ?? null,
    actions,
  });
  for (const identifier of PROVISIONED_BILLING_SERVICE_IDENTIFIERS) {
    const service = services.get(identifier);
    if (!service) localCatalogDrift();
    await ensureProvisionedServiceCredits({ db: params.db, service, write: params.write, actions });
  }
  const deepwater = services.get(DEEPWATER_PRIVACY_SPEC.serviceIdentifier);
  if (!deepwater) localCatalogDrift();
  await ensureRecurringAddon({
    db: params.db,
    deepwater,
    appId: app.id,
    accountId: account?.id ?? null,
    remote: params.catalog.recurringAddon,
    write: params.write,
    actions,
  });
  return actions;
}
