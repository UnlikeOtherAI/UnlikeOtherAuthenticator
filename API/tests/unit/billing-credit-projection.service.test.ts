import {
  BillingAppKeyPurpose,
  BillingCreditAutoTopUpState,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { assertBillingCreditsContract } from '../../src/routes/billing/credits.js';
import type { CreditCollectionContext } from '../../src/services/billing-credit-account.service.js';
import type { BillingCreditProjectionData } from '../../src/services/billing-credit-projection-data.service.js';
import { buildBillingCreditsProjection } from '../../src/services/billing-credit-projection.service.js';
import type { BillingFundingViewer } from '../../src/services/billing-funding-viewer.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');
const service = { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' };
const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service,
};
const collection = {
  account: {
    id: 'stripe_account_1',
    stripeAccountId: 'acct_uoa',
    livemode: false,
    createdAt: now,
    updatedAt: now,
  },
  stripeCollectionEnabled: true,
} satisfies CreditCollectionContext;
const period = {
  key: '2026-07',
  startsAt: new Date('2026-07-01T00:00:00.000Z'),
  endsAt: new Date('2026-08-01T00:00:00.000Z'),
};

function projectionData(balanceMicrocredits = 2_000_000_000n): BillingCreditProjectionData {
  return {
    creditAccount: {
      id: 'credit_account_1',
      accountId: collection.account.id,
      currency: 'USD',
      balanceMicrocredits,
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: null,
      autoTopUpThresholdMicrocredits: 500_000_000n,
      autoTopUpRefillOfferId: 'offer_refill',
      autoTopUpMonthlyChargeCapMinor: 10_000n,
      autoTopUpConsentVersion: 'credits-v1',
      autoTopUpConsentedAt: now,
      stripePaymentMethodId: 'pm_1',
      paymentMethodSummary: { brand: 'Visa', last4: '4242' },
      autoTopUpConsentedBy: { id: 'user_1', name: 'Viewer' },
    },
    policy: null,
    catalogs: [],
    settlements: [
      {
        id: 'settlement_1',
        serviceId: service.id,
        service,
        cumulativeCreditsConsumedMicrocredits: 500_000_000n,
      },
    ],
    allocations: [
      {
        id: 'allocation_viewer',
        settlementId: 'settlement_1',
        attributedUserId: 'user_1',
        cumulativeCreditsConsumedMicrocredits: 100_000_000n,
        adjustment: { sequence: 1 },
        attributedUser: { id: 'user_1', name: 'Viewer' },
      },
      {
        id: 'allocation_other',
        settlementId: 'settlement_1',
        attributedUserId: 'user_2',
        cumulativeCreditsConsumedMicrocredits: 300_000_000n,
        adjustment: { sequence: 1 },
        attributedUser: { id: 'user_2', name: 'Secret colleague' },
      },
      {
        id: 'allocation_null',
        settlementId: 'settlement_1',
        attributedUserId: null,
        cumulativeCreditsConsumedMicrocredits: 100_000_000n,
        adjustment: { sequence: 1 },
        attributedUser: null,
      },
    ],
    entries: [
      {
        id: 'entry_1',
        occurredAt: now,
        service,
        attributedUserId: 'user_2',
        attributedUser: { id: 'user_2', name: 'Secret colleague' },
        kind: BillingCreditEntryKind.TOP_UP,
        direction: BillingCreditEntryDirection.CREDIT,
        amountMicrocredits: 1_000_000_000n,
        balanceAfterMicrocredits: 2_000_000_000n,
      },
    ],
    periodEntries: [],
    pending: [],
    unresolvedAttempts: [],
    autoTopUpChargedMinor: 0n,
  } as unknown as BillingCreditProjectionData;
}

function viewer(billingManager: boolean): BillingFundingViewer {
  return {
    userId: 'user_1',
    displayName: 'Viewer',
    organisationId: 'org_1',
    teamId: 'team_1',
    organisationRole: billingManager ? 'admin' : 'member',
    teamRole: 'member',
    billingManager,
  };
}

describe('privacy-safe shared credit projection', () => {
  it('gives managers full user, payment, consent, and service detail', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: projectionData(),
      now,
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    expect(result).toMatchObject({
      viewer: { role: 'billing_manager' },
      credit_balance: { label: 'Remaining credits', credits: '2000' },
      automatic_top_up: {
        payment_method: { status: 'ready', display: 'Visa ending in 4242' },
        consent: { consented_by: { display_name: 'Viewer' } },
      },
      credit_summary: {
        consumed_breakdown: [
          {
            users: expect.arrayContaining([
              expect.objectContaining({ user_id: 'user_1' }),
              expect.objectContaining({
                user_id: 'user_2',
                display_name: 'Secret colleague',
              }),
            ]),
          },
        ],
      },
    });
  });

  it('collapses other users and strips card and consent identity for members', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(false),
      period,
      data: projectionData(),
      now,
    });
    const serialized = JSON.stringify(result);

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    expect(result).toMatchObject({
      viewer: { role: 'member' },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
      pending_credits: { payment_amount: null },
      funding_policy: null,
      automatic_top_up: { payment_method: { status: 'ready' } },
      credit_summary: {
        consumed_breakdown: [
          {
            credits_consumed: { credits: '500' },
            viewer_credits_consumed: { credits: '100' },
            other_team_members_credits_consumed: { credits: '300' },
            unattributed_credits_consumed: { credits: '100' },
          },
        ],
      },
      recent_entries: [{ attribution: 'other_team_members' }],
    });
    expect(serialized).not.toContain('user_2');
    expect(serialized).not.toContain('Secret colleague');
    expect(serialized).not.toContain('4242');
    expect(serialized).not.toContain('consented_by');
    expect(serialized).not.toContain('monthly_cap');
    expect(serialized).not.toContain('threshold');
  });

  it('represents verified reversal debt without allowing an unsigned balance shape', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(false),
      period,
      data: projectionData(-250_000_000n),
      now,
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    expect(result.credit_balance).toMatchObject({ state: 'debt', credits: '-250' });
  });

  it('enables only manager actions backed by exact policy and Stripe catalog evidence', () => {
    const data = projectionData();
    Object.assign(data.creditAccount, {
      autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
      autoTopUpOptionId: null,
      autoTopUpConsentRevisionId: null,
      autoTopUpConsentVersion: null,
      autoTopUpConsentedAt: null,
      autoTopUpConsentedBy: null,
      stripePaymentMethodId: null,
      paymentMethodSummary: null,
    });
    data.policy = {
      id: 'policy_1',
      topUpEnabled: true,
      automaticTopUpEnabled: true,
      automaticConsentVersion: 'credits-v1',
      topUpOffers: [
        {
          id: 'offer_1',
          key: '20k',
          name: '20,000 credits',
          description: 'Fixed offer',
          catalogKey: 'credits-20k',
          catalogVersion: 1,
          paymentAmountMinor: 2_000n,
          creditsReceivedMicrocredits: 20_000_000_000n,
        },
      ],
      autoTopUpOptions: [
        {
          id: 'option_1',
          thresholdMicrocredits: 5_000_000_000n,
          monthlyChargeCapMinor: 10_000n,
          refillOfferId: 'offer_1',
          refillOffer: {
            id: 'offer_1',
            active: true,
            automaticTopUpEligible: true,
            catalogKey: 'credits-20k',
            catalogVersion: 1,
            paymentAmountMinor: 2_000n,
            creditsReceivedMicrocredits: 20_000_000_000n,
          },
        },
      ],
    } as NonNullable<BillingCreditProjectionData['policy']>;
    data.catalogs = [
      {
        id: 'catalog_1',
        key: 'credits-20k',
        version: 1,
        paymentAmountMinor: 2_000n,
        creditsReceivedMicrocredits: 20_000_000_000n,
        stripeProductId: 'prod_20k',
        stripePriceId: 'price_20k',
      },
    ] as BillingCreditProjectionData['catalogs'];

    const available = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data,
      now,
      actionReadiness: {
        executableCatalogIds: new Set(['catalog_1']),
        paymentMethodReady: false,
        topUpCheckoutReady: true,
        setupCheckoutReady: true,
        disableReady: true,
        recoverReady: false,
      },
    });
    expect(available).toMatchObject({
      capabilities: { can_top_up: true, can_manage_automatic_top_up: true },
      funding_policy: { offers: [{ available: true, action: { enabled: true } }] },
      automatic_top_up: { options: [{ setup_action: { enabled: true } }] },
    });

    data.catalogs = [];
    const unavailable = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data,
      now,
      actionReadiness: {
        executableCatalogIds: new Set(),
        paymentMethodReady: false,
        topUpCheckoutReady: true,
        setupCheckoutReady: true,
        disableReady: true,
        recoverReady: false,
      },
    });
    expect(unavailable).toMatchObject({
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
      funding_policy: { offers: [{ available: false, action: { enabled: false } }] },
      automatic_top_up: { options: [{ setup_action: { enabled: false } }] },
    });
  });
});
