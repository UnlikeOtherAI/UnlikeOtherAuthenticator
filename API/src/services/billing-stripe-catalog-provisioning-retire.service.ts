import {
  addCatalogAction,
  type CatalogDb,
  type CatalogProvisioningAction,
} from './billing-stripe-catalog-provisioning-local.shared.js';
import { ORIGINAL_USD_CREDIT_OFFER_KEYS } from './billing-stripe-catalog-provisioning-spec.js';

/**
 * Retire what the catalog provisioned for an active service it no longer
 * covers: its GBP and EUR policies with their offers, and USD offers beyond the
 * original four. Its USD policy, the original USD offers and its reload options
 * are kept and listed until someone decides. Retiring deactivates; nothing is
 * deleted, and catalogs are shared by every service, so none is touched.
 */
export async function retireUncoveredServiceCredits(params: {
  db: CatalogDb;
  service: { id: string; identifier: string };
  write: boolean;
  now: Date;
  actions: CatalogProvisioningAction[];
}): Promise<void> {
  const { db, service } = params;
  const policies = await db.billingCreditFundingPolicy.findMany({ where: { serviceId: service.id, active: true },
    orderBy: [{ currency: 'asc' }, { version: 'asc' }] });
  for (const policy of policies) {
    const policyKey = `${service.identifier}/${policy.currency}/v${policy.version}`;
    const [offers, options] = await Promise.all([
      db.billingCreditTopUpOffer.findMany({ where: { policyId: policy.id, active: true }, orderBy: { key: 'asc' } }),
      db.billingCreditAutoTopUpOption.findMany({ where: { policyId: policy.id, active: true }, orderBy: { key: 'asc' } }),
    ]);
    const original = policy.currency === 'USD';
    for (const offer of offers) {
      const keep = original && ORIGINAL_USD_CREDIT_OFFER_KEYS.includes(offer.key);
      const key = `${service.identifier}/${offer.key}/v${offer.version}`;
      if (keep) {
        addCatalogAction(params.actions, 'credit_top_up_offer_kept_uncovered', key, false, 'skipped', offer.id);
        continue;
      }
      if (params.write) {
        await db.billingCreditTopUpOffer.update({ where: { id: offer.id },
          data: { active: false, deactivatedAt: params.now } });
      }
      addCatalogAction(params.actions, 'credit_top_up_offer_retired', key, false, 'retired', offer.id);
    }
    for (const option of options) {
      const key = `${service.identifier}/${option.key}/v${option.version}`;
      if (original) {
        addCatalogAction(params.actions, 'credit_auto_top_up_option_kept_uncovered', key, false, 'skipped', option.id);
        continue;
      }
      if (params.write) {
        await db.billingCreditAutoTopUpOption.update({ where: { id: option.id },
          data: { active: false, deactivatedAt: params.now } });
      }
      addCatalogAction(params.actions, 'credit_auto_top_up_option_retired', key, false, 'retired', option.id);
    }
    if (original) {
      addCatalogAction(params.actions, 'credit_funding_policy_kept_uncovered', policyKey, false, 'skipped', policy.id);
      continue;
    }
    if (params.write) {
      await db.billingCreditFundingPolicy.update({ where: { id: policy.id },
        data: { active: false, deactivatedAt: params.now } });
    }
    addCatalogAction(params.actions, 'credit_funding_policy_retired', policyKey, false, 'retired', policy.id);
  }
}
