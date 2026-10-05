import { BillingAppKeyPurpose, BillingCreditAutoTopUpState } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { getBillingCredits } from '../../src/services/billing-credits.service.js';
import { AppError } from '../../src/utils/errors.js';

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
      prepaidReservations: [],
      activeReservedMicrocredits: 0n,
      allocations: [],
      entries: [],
      periodEntries: [],
      pending: [],
      unresolvedAttempts: [],
      unresolvedTopUpCheckouts: [],
      unresolvedSetupCheckouts: [],
      autoTopUpChargedMinor: 0n,
      prepaidReservations: [],
      activeReservedMicrocredits: 0n,
    };
    const deps = {
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
      hasPendingSettlementWatch: vi.fn().mockResolvedValue(false),
      resolveViewer: vi.fn().mockResolvedValue({
        userId: request.userId,
        organisationId: request.organisationId,
        teamId: request.teamId,
        billingManager: true,
      }),
      loadProjectionData: vi.fn().mockResolvedValue(data),
      resolveControlledBy: vi.fn().mockResolvedValue(null),
    } as never;
    const result = await getBillingCredits({ request, actorToken: 'actor', credential }, deps);

    expect(fetchPortfolio).toHaveBeenCalled();
    expect(settlePortfolio).toHaveBeenCalled();
    expect(result).toMatchObject({
      collection: { stripe_collection_enabled: false, stripe_mode: 'test' },
      credit_balance: { label: 'Remaining credits', credits: '3000' },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
    });
    expect(result).not.toHaveProperty('attention');
    expect(result).not.toHaveProperty('funding_request');
    expect('billing_status' in result).toBe(false);
    settlePortfolio.mockRejectedValue(new AppError('INTERNAL', 409, 'LEDGER_METERING_UNRESOLVED_PAID_USAGE'));
    const pending = await getBillingCredits({
      request, actorToken: 'actor', credential, supportsBillingStatus: true,
    }, deps);
    expect(pending).toMatchObject({
      credit_balance: { credits: '3000' },
      billing_status: { settlement_state: 'pending_reconciliation' },
    });
    await expect(getBillingCredits({ request, actorToken: 'actor', credential }, deps))
      .rejects.toThrow('BILLING_CREDITS_PENDING_RECONCILIATION');
    settlePortfolio.mockReset();
    deps.hasPendingSettlementWatch.mockResolvedValue(true);
    const olderPeriodHold = await getBillingCredits({
      request, actorToken: 'actor', credential, supportsBillingStatus: true,
    }, deps);
    expect(olderPeriodHold.billing_status?.settlement_state).toBe('pending_reconciliation');
  });

  it('adds source attention and funding help only for a negotiated member projection', async () => {
    const data = {
      creditAccount: {
        id: 'credit_1',
        balanceMicrocredits: 0n,
        autoTopUpGeneration: 0,
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
      prepaidReservations: [],
      activeReservedMicrocredits: 0n,
    };
    const dependencies = {
      sharedSecret: 'test-shared-secret',
      hasPendingSettlementWatch: vi.fn().mockResolvedValue(false),
      now: () => now,
      resolveEntitlement: vi.fn().mockResolvedValue({
        payload: {
          tariff: { usage_billing_enabled: true, payment_collection_enabled: true },
        },
      }),
      resolveCollection: vi.fn().mockResolvedValue({
        account: { id: 'account_1', stripeAccountId: 'acct_1', livemode: false },
        stripeCollectionEnabled: false,
        stripe: null,
      }),
      ensureCreditAccount: vi.fn().mockResolvedValue({ id: 'credit_1' }),
      resolvePortfolioProduct: vi.fn().mockResolvedValue('deepwater'),
      fetchPortfolio: vi.fn().mockResolvedValue({ snapshot_cursor: 'cursor_1' }),
      settlePortfolio: vi.fn(),
      resolveViewer: vi.fn().mockResolvedValue({
        userId: request.userId,
        organisationId: request.organisationId,
        teamId: request.teamId,
        billingManager: false,
      }),
      loadProjectionData: vi.fn().mockResolvedValue(data),
      resolveActionReadiness: vi.fn().mockResolvedValue({ paymentMethodExpired: false }),
      resolveControlledBy: vi.fn().mockResolvedValue(null),
      resolveFundingRecipients: vi.fn().mockResolvedValue(['manager_1']),
      resolveLatestFundingCreditEntryId: vi.fn().mockResolvedValue(null),
    };
    const result = await getBillingCredits(
      { request, actorToken: 'actor', credential, locale: 'cs' },
      dependencies as never,
    );

    expect(result).toMatchObject({
      attention: [{ kind: 'credits_exhausted', event_key: expect.stringMatching(/^bca1_/) }],
      funding_request: {
        label: 'Požádat o pomoc s platbou',
        enabled: true,
        disabled_reason: null,
        request: {
          method: 'POST',
          path: '/billing/v1/credits/funding-request',
          body: {
            product: 'deepwater',
            organisation_id: 'org_1',
            team_id: 'team_1',
            user_id: 'user_1',
          },
        },
      },
    });

    data.creditAccount.balanceMicrocredits = 1_000_001n;
    data.activeReservedMicrocredits = 1_000_001n;
    const reserved = await getBillingCredits(
      { request, actorToken: 'actor', credential, locale: 'cs' }, dependencies as never,
    );
    expect(reserved.credit_balance).toMatchObject({ credits: '0', state: 'zero' });
    expect(reserved.attention?.map((event) => event.kind)).toContain('credits_exhausted');
    data.activeReservedMicrocredits = 1_000_000n;
    const fractional = await getBillingCredits(
      { request, actorToken: 'actor', credential, locale: 'cs' }, dependencies as never,
    );
    expect(fractional.credit_balance).toMatchObject({ credits: '0.000001', state: 'available' });
    expect(fractional.attention?.map((event) => event.kind)).not.toContain('credits_exhausted');

    const noRecipients = vi.fn().mockResolvedValue([]);
    const noRecipientResult = await getBillingCredits(
      { request, actorToken: 'actor', credential, locale: 'cs' },
      {
        ...dependencies,
        resolveFundingRecipients: noRecipients,
      } as never,
    );
    expect(noRecipientResult).not.toHaveProperty('funding_request');
    expect(noRecipients).toHaveBeenCalledOnce();

    const freeRecipients = vi.fn();
    const freeResult = await getBillingCredits(
      { request, actorToken: 'actor', credential, locale: 'cs' },
      {
        ...dependencies,
        resolveEntitlement: vi.fn().mockResolvedValue({
          payload: {
            tariff: { usage_billing_enabled: false, payment_collection_enabled: true },
          },
        }),
        resolveFundingRecipients: freeRecipients,
      } as never,
    );
    expect(freeResult).not.toHaveProperty('funding_request');
    expect(freeResult.attention).toEqual([]);
    expect(freeRecipients).not.toHaveBeenCalled();
  });
});
