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
  outcome: 'created' | 'no-op' | 'skipped' | 'retired';
  /** The row a retirement or a kept uncovered row refers to. */
  id?: string;
};

export type CatalogDriftDetails = Record<string, string | number | boolean | null | string[]>;

/**
 * A local row disagrees with the exact catalog. `check` names the rule that
 * refused and `details` the rows by id and the fields that differ; neither
 * carries a secret, an amount from Stripe or customer data.
 */
export class CatalogDriftError extends AppError {
  public constructor(code: 'BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT' | 'STRIPE_COMMERCIAL_CATALOG_DRIFT',
    public readonly check: string, public readonly details: CatalogDriftDetails) {
    super('INTERNAL', 409, code);
  }
}

export function localCatalogDrift(check: string, details: CatalogDriftDetails = {}): never {
  throw new CatalogDriftError('BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT', check, details);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

/** The fields of `expected` that `actual` does not hold exactly. */
export function differingFields(actual: object, expected: Record<string, unknown>): string[] {
  const values = actual as Record<string, unknown>;
  return Object.keys(expected).filter((key) => !sameValue(values[key], expected[key]));
}

export function addCatalogAction(
  actions: CatalogProvisioningAction[],
  resource: string,
  key: string,
  created: boolean,
  outcome?: 'skipped' | 'retired',
  id?: string,
): void {
  actions.push({ resource, key, outcome: outcome ?? (created ? 'created' : 'no-op'), ...(id ? { id } : {}) });
}

export function sameCatalogStrings(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}
