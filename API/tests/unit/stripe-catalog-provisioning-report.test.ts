import { describe, expect, it } from 'vitest';

import { provisioningErrorReport } from '../../src/cli/stripe-catalog-provisioning-report.js';
import { localCatalogDrift } from '../../src/services/billing-stripe-catalog-provisioning-local.shared.js';
import { AppError } from '../../src/utils/errors.js';

function thrown(run: () => never): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('Stripe catalog provisioning error report', () => {
  it('names the drift check and the row ids it saw', () => {
    const error = thrown(() => localCatalogDrift('credit_offer_terms', { offer_id: 'bcto_1', fields: ['name'] }));
    expect(provisioningErrorReport(error)).toEqual({ error: 'BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT',
      check: 'credit_offer_terms', details: { offer_id: 'bcto_1', fields: ['name'] } });
  });

  it('keeps other refusals to their code and hides anything else', () => {
    expect(provisioningErrorReport(new AppError('INTERNAL', 409, 'STRIPE_COMMERCIAL_CATALOG_MODE_MISMATCH')))
      .toEqual({ error: 'STRIPE_COMMERCIAL_CATALOG_MODE_MISMATCH' });
    expect(provisioningErrorReport(new Error('connect ECONNREFUSED postgres://user:secret@host')))
      .toEqual({ error: 'STRIPE_CATALOG_PROVISIONING_FAILED' });
  });
});
