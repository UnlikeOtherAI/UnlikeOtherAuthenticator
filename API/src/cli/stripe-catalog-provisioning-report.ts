import { CatalogDriftError } from '../services/billing-stripe-catalog-provisioning-local.shared.js';
import { isAppError } from '../utils/errors.js';

function safeErrorCode(error: unknown): string {
  if (isAppError(error) && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'STRIPE_CATALOG_PROVISIONING_FAILED';
}

/** The refusal, and for drift the check that refused with the row ids it saw; never a secret. */
export function provisioningErrorReport(error: unknown): Record<string, unknown> {
  const report: Record<string, unknown> = { error: safeErrorCode(error) };
  if (error instanceof CatalogDriftError) Object.assign(report, { check: error.check, details: error.details });
  return report;
}
