import { BillingCreditAutoTopUpState, BillingCreditEntryDirection, BillingCreditEntryKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { assertBillingCreditsContract } from '../../src/routes/billing/credits.js';

import type { BillingCreditProjectionData } from '../../src/services/billing-credit-projection-data.service.js';
import { buildBillingCreditsProjection } from '../../src/services/billing-credit-projection.service.js';



import { now, service, credential, collection, period, projectionData, viewer } from '../helpers/credit-projection-fixture.js';

describe('privacy-safe shared credit projection',()=>{
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


  it('subtracts prepaid holds from available credits and shows settled debits by team', () => {
    const data = projectionData();
    data.activeReservedMicrocredits = 250_000_000n;
    data.prepaidReservations = [
      { status: 'ACTIVE', reservedMicrocredits: 250_000_000n, debitedMicrocredits: null,
        userId: 'user_1', tariff: { service } },
      { status: 'SETTLED', reservedMicrocredits: 3_000_000n,
        debitedMicrocredits: 2_000_000n, userId: 'user_2', tariff: { service } },
    ] as BillingCreditProjectionData['prepaidReservations'];
    const manager = buildBillingCreditsProjection({ credential, collection,
      viewer: viewer(true), period, data, now });
    expect(manager.credit_balance.credits).toBe('1750');
    expect(manager.credit_summary.credits_consumed.credits).toBe('502');
    expect(manager.credit_summary.consumed_breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ credits_consumed: expect.objectContaining({ credits: '2' }),
        users: [expect.objectContaining({ user_id: 'user_2' })] }),
    ]));
    const member = buildBillingCreditsProjection({ credential, collection,
      viewer: viewer(false), period, data, now });
    expect(JSON.stringify(member)).not.toContain('Secret colleague');
    expect(member.credit_summary.credits_consumed.credits).toBe('502');
  });


  it('pauses projected automatic top-up when the remaining limit cannot cover one refill', () => {
    const data = projectionData();
    data.creditAccount.autoTopUpOptionId = 'option_1';
    data.creditAccount.autoTopUpMonthlyChargeCapMinor = 10_000n;
    data.autoTopUpChargedMinor = 8_500n;
    data.policy = {
      topUpEnabled: true,
      automaticTopUpEnabled: true,
      automaticConsentVersion: 'credits-v1',
      topUpOffers: [],
      autoTopUpOptions: [
        {
          id: 'option_1',
          refillOfferId: 'offer_refill',
          thresholdMicrocredits: 500_000_000n,
          monthlyChargeCapMinor: 10_000n,
          refillOffer: {
            id: 'offer_refill',
            active: true,
            automaticTopUpEligible: true,
            paymentAmountMinor: 2_000n,
            creditsReceivedMicrocredits: 20_000_000_000n,
          },
        },
      ],
    } as never;

    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data,
      now,
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    expect(result.automatic_top_up).toMatchObject({
      state: 'paused',
      display_status: 'Paused',
      description: 'The monthly limit cannot cover another refill. It resets on August 1, 2026.',
      charged_this_month: { amount_minor: '8500', currency: 'USD' },
      remaining_monthly_cap: { amount_minor: '1500', currency: 'USD' },
    });
  });


  it('shows historical fractional entries without hiding microcredit changes', () => {

    const data = projectionData(49_999_000_000n);
    data.settlements[0]!.cumulativeCreditsConsumedMicrocredits = 1_000_000n;
    data.allocations = [
      {
        id: 'allocation_viewer',
        settlementId: 'settlement_1',
        attributedUserId: 'user_1',
        cumulativeCreditsConsumedMicrocredits: 1_000_000n,
        adjustment: { sequence: 2 },
        attributedUser: { id: 'user_1', name: 'Viewer' },
      },
    ] as BillingCreditProjectionData['allocations'];
    data.entries = [
      {
        id: 'whole_credit_normalization',
        occurredAt: new Date('2026-07-21T12:01:00.000Z'),
        service,
        attributedUserId: null,
        attributedUser: null,
        kind: BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION,
        direction: BillingCreditEntryDirection.CREDIT,
        amountMicrocredits: 83_650n,
        balanceAfterMicrocredits: 49_999_000_000n,
      },
      {
        id: 'legacy_fractional_usage',
        occurredAt: now,
        service,
        attributedUserId: null,
        attributedUser: null,
        kind: BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION,
        direction: BillingCreditEntryDirection.DEBIT,
        amountMicrocredits: 1_083_650n,
        balanceAfterMicrocredits: 49_998_916_350n,
      },
    ] as BillingCreditProjectionData['entries'];

    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data,
      now,
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    expect(result.credit_balance).toMatchObject({ credits: '49999', display: '49,999 credits' });
    expect(result.credit_summary.credits_consumed).toMatchObject({
      credits: '1',
      display: '1 credit',
    });
    expect(result.recent_entries).toEqual([
      expect.objectContaining({
        id: 'whole_credit_normalization',
        credits: expect.objectContaining({ credits: '0.08365', display: '0.08365 credits' }),
        credit_balance_after: expect.objectContaining({ credits: '49999' }),
      }),
      expect.objectContaining({
        credits: expect.objectContaining({ credits: '1.08365', display: '1.08365 credits' }),
        credit_balance_after: expect.objectContaining({
          credits: '49998.91635', display: '49,998.91635 credits',
        }),
      }),
    ]);
  });


  it('offers a team billing manager no funding surface while the organisation pays', () => {
    const controlledBy = {
      scope: 'organisation' as const,
      organisation_id: 'org_1',
      organisation_name: 'Acme',
      message: 'Billing for this team is managed for the whole of Acme.',
      can_manage: false,
      manage_action_id: null,
    };

    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: projectionData(),
      now,
      controlledBy,
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    // The member shape, deliberately: the account being displayed now belongs
    // to the whole organisation, so a team manager must not see per-user
    // detail across it, and must not be offered a control that would 403.
    expect(result).toMatchObject({
      controlled_by: controlledBy,
      viewer: { role: 'member' },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
      funding_policy: null,
    });
    expect(result.automatic_top_up).not.toHaveProperty('options');
  });


  it('keeps the full funding surface for an organisation billing manager', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: projectionData(),
      now,
      controlledBy: {
        scope: 'organisation' as const,
        organisation_id: 'org_1',
        organisation_name: 'Acme',
        message: 'Billing for this team is managed for the whole of Acme.',
        can_manage: true,
        manage_action_id: 'org-billing-open' as const,
      },
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
    expect(result).toMatchObject({
      viewer: { role: 'billing_manager' },
      controlled_by: { can_manage: true, manage_action_id: 'org-billing-open' },
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
      locale: 'cs',
      actionReadiness: {
        executableCatalogIds: new Set(['catalog_1']),
        paymentMethodReady: false,
        topUpCheckoutReady: true,
        resumableTopUpOfferId: null,
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
    if (available.viewer.role !== 'billing_manager') {
      throw new Error('Expected manager funding actions');
    }
    expect(available.funding_policy?.description).toContain(
      'Začněte nejmenším dostupným dobitím.',
    );

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
        resumableTopUpOfferId: null,
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
    if (unavailable.viewer.role !== 'billing_manager') {
      throw new Error('Expected manager funding actions');
    }
    expect(unavailable.funding_policy?.description).not.toContain(
      'Start with the smallest available top-up.',
    );
  });
});
