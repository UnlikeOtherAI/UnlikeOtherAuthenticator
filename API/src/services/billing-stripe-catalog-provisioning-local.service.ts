import { BillingRecurringAddonEntitlementScope } from '@prisma/client';

import {
  ensureProvisionedCreditCatalogs,
  ensureProvisionedServiceCredits,
} from './billing-stripe-catalog-provisioning-credits-local.service.js';
import {
  addCatalogAction,
  type CatalogDb,
  type CatalogProvisioningAction,
  differingFields,
  localCatalogDrift,
  sameCatalogStrings,
} from './billing-stripe-catalog-provisioning-local.shared.js';
import type { ValidatedStripeCommercialCatalog } from './billing-stripe-catalog-provisioning-remote.service.js';
import {
  DEEPWATER_PRIVACY_SPEC,
  PROVISIONED_BILLING_SERVICE_IDENTIFIERS,
} from './billing-stripe-catalog-provisioning-spec.js';

import { retireUncoveredServiceCredits } from './billing-stripe-catalog-provisioning-retire.service.js';

export type { CatalogProvisioningAction } from './billing-stripe-catalog-provisioning-local.shared.js';

/**
 * The active services to provision. An active service the catalog does not
 * cover (a product that sells no shared credits through it) is left alone, and
 * a covered product not yet registered is skipped until it is; both are named
 * in the plan so a later run can be compared.
 */
async function requireServices(db: CatalogDb, actions: CatalogProvisioningAction[]) {
  const services = await db.billingService.findMany({
    where: { active: true },
    select: { id: true, identifier: true, name: true, active: true },
  });
  const covered = new Set<string>(PROVISIONED_BILLING_SERVICE_IDENTIFIERS);
  const uncovered = services.filter((service) => !covered.has(service.identifier));
  for (const service of uncovered) {
    addCatalogAction(actions, 'billing_service_not_covered', service.identifier, false, 'skipped', service.id);
  }
  for (const identifier of PROVISIONED_BILLING_SERVICE_IDENTIFIERS) {
    if (!services.some((service) => service.identifier === identifier)) {
      addCatalogAction(actions, 'billing_service_not_registered', identifier, false, 'skipped');
    }
  }
  return {
    covered: new Map(services.filter((service) => covered.has(service.identifier))
      .map((service) => [service.identifier, service])),
    uncovered,
  };
}

async function requireDeepWaterApp(db: CatalogDb) {
  const apps = await db.app.findMany({
    where: { identifier: DEEPWATER_PRIVACY_SPEC.appIdentifier, active: true },
    select: { id: true, identifier: true, featureFlagsEnabled: true },
  });
  if (apps.length !== 1 || !apps[0]?.featureFlagsEnabled) {
    localCatalogDrift('deepwater_app', { app_ids: apps.map((app) => app.id),
      feature_flags_enabled: apps[0]?.featureFlagsEnabled ?? null });
  }
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
    const fields = differingFields(existing, { defaultState: false,
      description: DEEPWATER_PRIVACY_SPEC.featureFlagDescription });
    if (fields.length > 0) localCatalogDrift('deepwater_feature_flag', { app_id: params.appId, fields });
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
    const fields = differingFields(offer, { active: true, deactivatedAt: null, name: DEEPWATER_PRIVACY_SPEC.name,
      description: DEEPWATER_PRIVACY_SPEC.description, monthlyAmountMinor: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor,
      currency: DEEPWATER_PRIVACY_SPEC.currency });
    if (!sameCatalogStrings(offer.benefits, DEEPWATER_PRIVACY_SPEC.benefits)) fields.push('benefits');
    if (fields.length > 0) localCatalogDrift('recurring_addon_offer_terms', { offer_id: offer.id, fields });
    addCatalogAction(params.actions, 'recurring_addon_offer', 'deepwater/privacy/v1', false);
  } else {
    const other = offers.find((candidate) => candidate.active);
    if (other) localCatalogDrift('recurring_addon_offer_other_version_active', { offer_id: other.id, version: other.version });
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
    const fields = differingFields(expectedPolicy, { active: true, serviceId: params.deepwater.id });
    if (fields.length > 0) localCatalogDrift('recurring_addon_policy_terms', { policy_id: expectedPolicy.id, fields });
    const others = policies.filter((policy) => policy.active && policy.id !== expectedPolicy.id);
    if (others.length > 0) {
      localCatalogDrift('recurring_addon_policy_other_active', { policy_ids: others.map((policy) => policy.id) });
    }
    addCatalogAction(
      params.actions,
      'recurring_addon_feature_policy',
      'deepwater/privacy/team',
      false,
    );
  } else {
    const active = policies.filter((policy) => policy.active);
    if (active.length > 0) {
      localCatalogDrift('recurring_addon_policy_other_active', { policy_ids: active.map((policy) => policy.id) });
    }
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
    const fields = differingFields(row, { serviceId: params.deepwater.id, currency: DEEPWATER_PRIVACY_SPEC.currency,
      monthlyAmountMinor: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor, stripeLookupKey: params.remote.stripeLookupKey });
    if ((row.stripeProductId === null) !== (row.stripePriceId === null)) fields.push('partialStripeBinding');
    if (row.stripeProductId !== null && row.stripeProductId !== params.remote.stripeProductId) fields.push('stripeProductId');
    if (row.stripePriceId !== null && row.stripePriceId !== params.remote.stripePriceId) fields.push('stripePriceId');
    if (fields.length > 0) localCatalogDrift('recurring_addon_catalog_terms', { catalog_id: row.id, fields });
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
  const holder = catalogs.find((catalog) => catalog.stripeLookupKey === params.remote.stripeLookupKey ||
    catalog.stripeProductId === params.remote.stripeProductId || catalog.stripePriceId === params.remote.stripePriceId);
  if (holder) localCatalogDrift('recurring_addon_price_bound_elsewhere', { holder_catalog_id: holder.id });
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
  const { covered: services, uncovered } = await requireServices(params.db, actions);
  const app = await requireDeepWaterApp(params.db);
  await ensureFeatureFlag({ db: params.db, appId: app.id, write: params.write, actions });
  const account = await ensureStripeAccount({ ...params, actions });
  await ensureProvisionedCreditCatalogs({
    ...params,
    accountId: account?.id ?? null,
    actions,
  });
  for (const service of services.values()) {
    await ensureProvisionedServiceCredits({ db: params.db, service, write: params.write, actions });
  }
  const now = new Date();
  for (const service of uncovered) {
    await retireUncoveredServiceCredits({ db: params.db, service, write: params.write, now, actions });
  }
  const deepwater = services.get(DEEPWATER_PRIVACY_SPEC.serviceIdentifier);
  if (!deepwater) localCatalogDrift('deepwater_service_missing', { service: DEEPWATER_PRIVACY_SPEC.serviceIdentifier });
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
