import { describe, expect, it } from 'vitest';

import { billingStatementActions } from '../../src/services/billing-statement-action.service.js';

describe('billing statement action copy', () => {
  it('localizes labels and disabled reasons while keeping the action body stable', () => {
    const request = {
      product: 'deepwater',
      organisationId: 'org_1',
      teamId: 'team_1',
      userId: 'user_1',
    };
    const result = billingStatementActions(
      {
        can_manage: true,
        subscription: null,
        tariff: {
          payment_collection_enabled: false,
          collection_mode: 'stripe',
        },
        stripe_collection_enabled: false,
      } as never,
      request,
      { checkoutReturnOrigins: ['https://billing.example.test'] } as never,
      'cs',
    );

    expect(result.actions[0]).toMatchObject({
      id: 'upgrade',
      label: 'Změnit tarif',
      disabled_reason: 'Online platba pro tento tarif není dostupná.',
      request: {
        method: 'POST',
        path: '/billing/v1/stripe/checkout-session',
        body: {
          product: 'deepwater',
          organisation_id: 'org_1',
          team_id: 'team_1',
          user_id: 'user_1',
        },
      },
    });
    expect(result.actions[1]?.label).toBe('Spravovat platby');
    expect(result.actions[2]?.label).toBe('Zrušit předplatné');
  });
});
