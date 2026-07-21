import { BillingAppKeyPurpose, BillingCreditAutoTopUpState } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { getBillingCredits } from '../../src/services/billing-credits.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');
const service = { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' };
const credential = {
  id: 'app_key_1',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://deepwater.example',
  actorAudience: 'https://authentication.example/billing',
  actorKeyId: 'key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://deepwater.example'],
  service,
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};

describe('shared credit reads while Stripe collection is disabled', () => {
  it('settles and projects Remaining credits while freezing all funding actions', async () => {
    const fetchPortfolio = vi.fn().mockResolvedValue({ snapshot_cursor: 'cursor_1' });
    const settlePortfolio = vi.fn();
    const data = {
      creditAccount: {
        id: 'credit_1',
        balanceMicrocredits: 3_000_000_000n,
        autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
        autoTopUpConsentVersion: null,
        autoTopUpConsentedAt: null,
        autoTopUpConsentedBy: null,
        autoTopUpThresholdMicrocredits: null,
        autoTopUpRefillOfferId: null,
        autoTopUpMonthlyChargeCapMinor: null,
        autoTopUpOptionId: null,
        autoTopUpConsentRevisionId: null,
        stripePaymentMethodId: null,
        paymentMethodSummary: null,
      },
      policy: null,
      catalogs: [],
      settlements: [],
      allocations: [],
      entries: [],
      periodEntries: [],
      pending: [],
      unresolvedAttempts: [],
      unresolvedTopUpCheckouts: [],
      unresolvedSetupCheckouts: [],
      autoTopUpChargedMinor: 0n,
    };
    const result = await getBillingCredits({ request, actorToken: 'actor', credential }, {
      now: () => now,
      resolveEntitlement: vi.fn(),
      resolveCollection: vi.fn().mockResolvedValue({
        account: { id: 'account_1', stripeAccountId: 'acct_1', livemode: false },
        stripeCollectionEnabled: false,
        stripe: null,
      }),
      ensureCreditAccount: vi.fn().mockResolvedValue({ id: 'credit_1' }),
      resolvePortfolioProduct: vi.fn().mockResolvedValue('deepwater'),
      fetchPortfolio,
      settlePortfolio,
      resolveViewer: vi.fn().mockResolvedValue({
        userId: request.userId,
        organisationId: request.organisationId,
        teamId: request.teamId,
        billingManager: true,
      }),
      loadProjectionData: vi.fn().mockResolvedValue(data),
    } as never);

    expect(fetchPortfolio).toHaveBeenCalled();
    expect(settlePortfolio).toHaveBeenCalled();
    expect(result).toMatchObject({
      collection: { stripe_collection_enabled: false, stripe_mode: 'test' },
      credit_balance: { label: 'Remaining credits', credits: '3000' },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
    });
  });
});
