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

function creditsData() {
  return {
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
    purchaseCurrency: 'USD',
    reloadCurrency: 'USD',
    regionPolicy: null,
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
  };
}

function creditsDeps(data: ReturnType<typeof creditsData>, fetchPortfolio: unknown, settlePortfolio: unknown) {
  return {
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
}

describe('credits valued in the billing region currency (credits protocol 2.3.0)', () => {
  it('reads the values for the listed entries only when the consumer negotiated them', async () => {
    const data = { ...creditsData(), entries: [
      { id: 'entry_1', occurredAt: now, service, kind: 'USAGE_SETTLEMENT', direction: 'DEBIT',
        amountMicrocredits: 1_000_000_000n, balanceAfterMicrocredits: 3_000_000_000n, attributedUserId: null },
      { id: 'entry_zero', occurredAt: now, service, kind: 'USAGE_SETTLEMENT', direction: 'DEBIT',
        amountMicrocredits: 0n, balanceAfterMicrocredits: 3_000_000_000n, attributedUserId: null },
    ] } as unknown as ReturnType<typeof creditsData>;
    const readDisplayValues = vi.fn().mockResolvedValue({
      currency: 'USD', balance: { currency: 'USD', amount: '3.00', amountMinor: 300n },
      nextRate: { currency: 'USD', usdPerUnit: '1', source: 'usd', asOf: now },
      entries: new Map([['entry_1', { currency: 'USD', amount: '1.00', amountMinor: 100n }]]),
    });
    const deps = { ...(creditsDeps(data, vi.fn().mockResolvedValue({}), vi.fn()) as object), readDisplayValues } as never;

    const older = await getBillingCredits({ request, actorToken: 'actor', credential, supportsBillingStatus: true }, deps);
    expect(readDisplayValues).not.toHaveBeenCalled();
    expect(older).not.toHaveProperty('region_rate');

    const result = await getBillingCredits({ request, actorToken: 'actor', credential, supportsBillingStatus: true,
      supportsRegionValue: true }, deps);
    expect(readDisplayValues).toHaveBeenCalledWith(
      { creditAccountId: 'credit_1', organisationId: 'org_1', entryIds: ['entry_1'] },
      expect.objectContaining({ stripe: null }),
    );
    expect(result).toMatchObject({
      credit_balance: { value: { amount: '3', amount_minor: '300', currency: 'USD', label: 'US$3.00 left' } },
      region_rate: { currency: 'USD', usd_per_unit: '1', credits_per_unit: '1000', source: 'usd' },
      recent_entries: [{ id: 'entry_1', value: { amount: '1', amount_minor: '100', currency: 'USD' } }],
    });
  });
});

describe('shared credit reads while Stripe collection is disabled', () => {
  it.each(['BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED',
    'BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED', 'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH'])(
    'keeps the confirmed balance available during %s', async (code) => {
      const data = creditsData();
      const settle = vi.fn().mockRejectedValue(new AppError('BAD_REQUEST', 409, code));
      const result = await getBillingCredits({ request, actorToken: 'actor', credential,
        supportsBillingStatus: true }, creditsDeps(data, vi.fn().mockResolvedValue({}), settle));
      expect(result).toMatchObject({ credit_balance: { credits: '3000' },
        billing_status: { settlement_state: 'pending_reconciliation' } });
      expect(data.creditAccount.balanceMicrocredits).toBe(3_000_000_000n);
    });
  it('settles and projects Remaining credits while freezing all funding actions', async () => {
    const fetchPortfolio = vi.fn().mockResolvedValue({ snapshot_cursor: 'cursor_1' });
    const settlePortfolio = vi.fn();
    const data = creditsData();
    const deps = creditsDeps(data, fetchPortfolio, settlePortfolio);
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

  it('refuses the former member financial projection before wallet, metering or attention reads',async()=>{
    const dependencies={resolveEntitlement:vi.fn().mockResolvedValue({payload:{tariff:{usage_billing_enabled:true,payment_collection_enabled:true}}}),
      resolveViewer:vi.fn().mockResolvedValue({billingManager:false}),resolveCollection:vi.fn(),loadProjectionData:vi.fn(),fetchPortfolio:vi.fn()};
    await expect(getBillingCredits({request,actorToken:'actor',credential,locale:'cs'},dependencies as never))
      .rejects.toMatchObject({statusCode:403,message:'BILLING_MANAGER_REQUIRED'});
    expect(dependencies.resolveCollection).not.toHaveBeenCalled();expect(dependencies.loadProjectionData).not.toHaveBeenCalled();
    expect(dependencies.fetchPortfolio).not.toHaveBeenCalled();
  });
});
