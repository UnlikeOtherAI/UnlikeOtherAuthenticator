import type { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

export type CatalogDb = Pick<
  Prisma.TransactionClient,
  | 'app'
  | 'billingCreditAutoTopUpOption'
  | 'billingCreditFundingPolicy'
  | 'billingCreditTopUpCatalog'
  | 'billingCreditTopUpOffer'
  | 'billingRecurringAddonCatalog'
  | 'billingRecurringAddonFeaturePolicy'
  | 'billingRecurringAddonOffer'
  | 'billingService'
  | 'billingStripeAccount'
  | 'featureFlagDefinition'
>;

export type CatalogProvisioningAction = {
  resource: string;
  key: string;
  outcome: 'created' | 'no-op';
};

export function localCatalogDrift(): never {
  throw new AppError('INTERNAL', 409, 'BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT');
}

export function addCatalogAction(
  actions: CatalogProvisioningAction[],
  resource: string,
  key: string,
  created: boolean,
): void {
  actions.push({ resource, key, outcome: created ? 'created' : 'no-op' });
}

export function sameCatalogStrings(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}
