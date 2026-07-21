import { describe, expect, it } from 'vitest';

import {
  assertCreditFundingMetadata,
  creditFundingMetadata,
  paymentBinding,
  sameCreditFundingMetadata,
  setupBinding,
} from '../../src/services/billing-credit-funding-binding.service.js';

const expected = {
  localType: 'automatic_top_up' as const,
  localId: 'attempt_1',
  serviceId: 'service_1',
  appKeyId: 'app_key_1',
  creditAccountId: 'credit_account_1',
};

describe('credit funding Stripe metadata binding', () => {
  it('emits and validates the complete local and commercial fingerprint', () => {
    const metadata = creditFundingMetadata(expected);

    expect(metadata).toEqual({
      uoa_credit_auto_top_up_attempt_id: expected.localId,
      uoa_service_id: expected.serviceId,
      uoa_app_key_id: expected.appKeyId,
      uoa_credit_account_id: expected.creditAccountId,
    });
    expect(() => assertCreditFundingMetadata(metadata, expected)).not.toThrow();
    expect(paymentBinding(metadata)).toEqual({
      localType: expected.localType,
      localId: expected.localId,
    });
  });

  it('rejects partial, conflicting, and rebound fingerprints at every parser seam', () => {
    const complete = creditFundingMetadata(expected);
    const { uoa_app_key_id: _removed, ...partial } = complete;
    const conflicting = {
      ...complete,
      uoa_credit_top_up_checkout_id: 'checkout_1',
    };
    const rebound = { ...complete, uoa_credit_account_id: 'credit_account_other' };

    expect(() => assertCreditFundingMetadata(partial, expected)).toThrow(
      'STRIPE_CREDIT_METADATA_INVALID',
    );
    expect(() => paymentBinding(conflicting)).toThrow('STRIPE_CREDIT_METADATA_INVALID');
    expect(() => setupBinding(partial)).toThrow('STRIPE_CREDIT_METADATA_INVALID');
    expect(() => sameCreditFundingMetadata(complete, rebound)).not.toThrow();
    expect(sameCreditFundingMetadata(complete, rebound)).toBe(false);
    expect(() => assertCreditFundingMetadata(rebound, expected)).toThrow(
      'STRIPE_CREDIT_BINDING_INVALID',
    );
  });
});
