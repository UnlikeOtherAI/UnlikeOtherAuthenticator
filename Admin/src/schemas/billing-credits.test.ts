import { describe, expect, it } from 'vitest';

import { BillingCreditAdjustmentFormSchema } from './billing-credits';

describe('BillingCreditAdjustmentFormSchema', () => {
  const valid = {
    signedCredits: '2500',
    reason: 'Restore a verified balance',
    idempotencyKey: 'restore:team-1:2026-07-21',
  };

  it.each(['2500', '-2500', '0.00001', '9223372036854.7758'])(
    'accepts an exact signed credit delta: %s',
    (signedCredits) => {
      expect(BillingCreditAdjustmentFormSchema.safeParse({ ...valid, signedCredits }).success).toBe(
        true,
      );
    },
  );

  it.each(['0', '-0', '+2500', '01', '1e3', '0.000001', '9223372036854.77581'])(
    'rejects an unsafe credit delta: %s',
    (signedCredits) => {
      expect(BillingCreditAdjustmentFormSchema.safeParse({ ...valid, signedCredits }).success).toBe(
        false,
      );
    },
  );

  it('requires an auditable reason and stable request reference', () => {
    expect(
      BillingCreditAdjustmentFormSchema.safeParse({
        ...valid,
        reason: '   ',
        idempotencyKey: 'contains spaces',
      }).success,
    ).toBe(false);
  });
});
