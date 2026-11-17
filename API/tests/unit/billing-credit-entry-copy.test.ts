import { describe, expect, it } from 'vitest';

import {
  BILLING_CREDIT_ENTRY_COPY, formatBillingCreditEntryCopy,
} from '../../src/services/billing-credit-entry-copy.catalog.js';

describe('credit entry copy', () => {
  it('labels a platform grant as a grant, never a purchase, in every locale', () => {
    const copy = formatBillingCreditEntryCopy('ADJUSTMENT', 'en-GB',
      { product: 'Team', credits: '10,000 credits' }, 'CREDIT');
    expect(copy.label).toBe('Credits granted by UnlikeOtherAI');
    expect(copy.detail).toContain('10,000 credits');
    expect(copy.detail).toContain('not a purchase');
    for (const catalog of Object.values(BILLING_CREDIT_ENTRY_COPY)) {
      expect(catalog.ADJUSTMENT_GRANT.label).not.toBe(catalog.ADJUSTMENT.label);
      expect(catalog.ADJUSTMENT_GRANT.detail).toContain('{credits}');
    }
  });

  it('keeps the neutral adjustment wording for a debit and other kinds unchanged', () => {
    expect(formatBillingCreditEntryCopy('ADJUSTMENT', 'en-US', { product: 'Team', credits: '5 credits' },
      'DEBIT').label).toBe('Account credit adjustment');
    expect(formatBillingCreditEntryCopy('TOP_UP', 'en-US', { product: 'Nessie', credits: '5 credits' },
      'CREDIT').label).toBe('Credits added from Nessie');
  });
});
