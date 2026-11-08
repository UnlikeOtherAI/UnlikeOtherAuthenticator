import { describe, expect, it, vi } from 'vitest';

import {
  billingCreditFundingRequestId,
  buildBillingCreditAttention,
  createBillingCreditFundingRequest,
  requireBillingFundingRecipients,
  resolveLatestBillingFundingCreditEntryId,
  resolveBillingFundingRequestRecipients,
} from '../../src/services/billing-credit-funding-request.service.js';
import { BILLING_CREDIT_ATTENTION_COPY } from '../../src/services/billing-credit-attention-copy.catalog.js';

describe('billing credit funding request', () => {
  it('returns deduplicated manager IDs selected by the fresh organisation authority query', async () => {
    const findMany=vi.fn().mockResolvedValue([{userId:'org-admin'},{userId:'org-owner'},{userId:'org-admin'}]);
    const database={organisation:{findFirst:vi.fn().mockResolvedValue({ownerId:'org-owner'})},orgMember:{findMany}};
    const result=await resolveBillingFundingRequestRecipients({organisationId:'org-a',teamId:'request-team',
      requesterUserId:'member',organisationPays:true},{prisma:database as never});
    expect(result).toEqual(['org-admin','org-owner']);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({orgId:'org-a',
      status:'ACTIVE',userId:{not:'member'},user:expect.objectContaining({lifecycleStatus:'ACTIVE'}),
      OR:[{role:{in:['owner','admin']}},{userId:'org-owner'}]})}));
    // No requester-team predicate: real-PG tests establish roles, lifecycle and foreign-org exclusion.
    expect(JSON.stringify(findMany.mock.calls[0])).not.toContain('request-team');
  });
  it('does not query recipient memberships for an inactive or absent organisation', async () => {
    const findMany=vi.fn();const database={organisation:{findFirst:vi.fn().mockResolvedValue(null)},orgMember:{findMany}};
    expect(await resolveBillingFundingRequestRecipients({organisationId:'gone',teamId:'request-team',
      requesterUserId:'member',organisationPays:false},{prisma:database as never})).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('keeps a request id stable for the same source scope and UTC day without exposing identifiers', () => {
    const first = billingCreditFundingRequestId({
      accountId: 'account-a',
      organisationId: 'org-a',
      teamId: 'team-a',
      requesterUserId: 'user-a',
      now: new Date('2026-10-04T00:15:00.000Z'),
      secret: 'test-shared-secret',
    });
    const sameDay = billingCreditFundingRequestId({
      accountId: 'account-a',
      organisationId: 'org-a',
      teamId: 'team-a',
      requesterUserId: 'user-a',
      now: new Date('2026-10-04T23:59:00.000Z'),
      secret: 'test-shared-secret',
    });
    const nextDay = billingCreditFundingRequestId({
      accountId: 'account-a',
      organisationId: 'org-a',
      teamId: 'team-a',
      requesterUserId: 'user-a',
      now: new Date('2026-10-05T00:00:00.000Z'),
      secret: 'test-shared-secret',
    });

    expect(first).toBe(sameDay);
    expect(first).not.toBe(nextDay);
    expect(first).not.toContain('account-a');
    expect(first).not.toContain('user-a');
  });

  it('keys balance events from the stable latest positive funding credit, not a bounded recent-entry list', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'funding_entry_stable' });
    const latestEntryId = await resolveLatestBillingFundingCreditEntryId(
      { creditAccountId: 'credit-account-a' },
      { prisma: { billingCreditEntry: { findFirst } } as never },
    );

    expect(latestEntryId).toBe('funding_entry_stable');
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        creditAccountId: 'credit-account-a',
        direction: 'CREDIT',
        kind: {
          in: ['TOP_UP', 'AUTOMATIC_TOP_UP', 'REFUND_REVERSAL', 'DISPUTE_REVERSAL', 'ADJUSTMENT'],
        },
        amountMicrocredits: { gt: 0n },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  });

  it('does not guess low-balance thresholds or warn for non-metered access', () => {
    const base = {
      creditAccountId: 'credit-account',
      balanceMicrocredits: 900n,
      periodKey: '2026-10',
      meteredBilling: true,
      account: {
        autoTopUpGeneration: 3,
        autoTopUpState: 'DISABLED',
        autoTopUpThresholdMicrocredits: null,
        autoTopUpMonthlyChargeCapMinor: null,
        autoTopUpOptionId: null,
      },
      policy: null,
      chargedThisMonthMinor: 0n,
      latestFundingCreditEntryId: null,
      paymentMethodExpired: false,
      secret: 'test-shared-secret',
    };

    expect(buildBillingCreditAttention(base)).toEqual([]);
    expect(buildBillingCreditAttention({ ...base, meteredBilling: false })).toEqual([]);
    expect(
      buildBillingCreditAttention({
        ...base,
        policy: {
          automaticTopUpEnabled: true,
          autoTopUpOptions: [
            {
              id: 'inactive-offer',
              thresholdMicrocredits: 1_000n,
              refillOffer: {
                paymentAmountMinor: 500n,
                active: false,
                automaticTopUpEligible: true,
              },
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('provides localized funding-help copy in every negotiated source locale', () => {
    expect(Object.keys(BILLING_CREDIT_ATTENTION_COPY)).toEqual([
      'cs',
      'en-US',
      'en-GB',
      'de',
      'es',
      'fr',
      'it',
    ]);
    expect(new Set(Object.values(BILLING_CREDIT_ATTENTION_COPY).map((copy) => copy.fundingRequestLabel)).size).toBe(6);
  });

  it('projects low/exhausted balance, payment action, expiry, and cap pause as stable opaque events', () => {
    const base = {
      creditAccountId: 'credit-account',
      balanceMicrocredits: 500n,
      periodKey: '2026-10',
      meteredBilling: true,
      account: {
        autoTopUpGeneration: 3,
        autoTopUpState: 'ACTIVE',
        autoTopUpThresholdMicrocredits: 700n,
        autoTopUpMonthlyChargeCapMinor: 500n,
        autoTopUpOptionId: 'option-a',
      },
      policy: {
        automaticTopUpEnabled: true,
        autoTopUpOptions: [
          {
            id: 'option-a',
            thresholdMicrocredits: 700n,
            refillOffer: {
              paymentAmountMinor: 500n,
              active: true,
              automaticTopUpEligible: true,
            },
          },
        ],
      },
      chargedThisMonthMinor: 100n,
      latestFundingCreditEntryId: 'entry-a',
      paymentMethodExpired: true,
      secret: 'test-shared-secret',
    };
    const first = buildBillingCreditAttention(base);
    const again = buildBillingCreditAttention(base);

    expect(first.map((event) => event.kind)).toEqual([
      'low_credits',
      'card_expired',
      'auto_top_up_paused',
    ]);
    expect(first).toEqual(again);
    expect(
      buildBillingCreditAttention({ ...base, balanceMicrocredits: 400n }).find(
        (event) => event.kind === 'low_credits',
      )?.event_key,
    ).toBe(first.find((event) => event.kind === 'low_credits')?.event_key);
    expect(first.every((event) => event.event_key.startsWith('bca1_'))).toBe(true);
    expect(first.every((event) => !event.event_key.includes('entry-a'))).toBe(true);

    const exhausted = buildBillingCreditAttention({
      ...base,
      balanceMicrocredits: 0n,
      account: { ...base.account, autoTopUpState: 'NEEDS_REVIEW' },
    });
    expect(exhausted.map((event) => event.kind)).toContain('credits_exhausted');
    expect(exhausted.map((event) => event.kind)).toContain('payment_action_required');
  });

  it('uses the lowest positive active option threshold when no consent threshold exists', () => {
    const attention = buildBillingCreditAttention({
      creditAccountId: 'credit-account',
      balanceMicrocredits: 400n,
      periodKey: '2026-10',
      meteredBilling: true,
      account: {
        autoTopUpGeneration: 1,
        autoTopUpState: 'DISABLED',
        autoTopUpThresholdMicrocredits: null,
        autoTopUpMonthlyChargeCapMinor: null,
        autoTopUpOptionId: null,
      },
      policy: {
        automaticTopUpEnabled: true,
        autoTopUpOptions: [
          {
            id: 'inactive',
            thresholdMicrocredits: 100n,
            refillOffer: {
              paymentAmountMinor: 100n,
              active: false,
              automaticTopUpEligible: true,
            },
          },
          {
            id: 'active-higher',
            thresholdMicrocredits: 800n,
            refillOffer: {
              paymentAmountMinor: 100n,
              active: true,
              automaticTopUpEligible: true,
            },
          },
          {
            id: 'active-lower',
            thresholdMicrocredits: 600n,
            refillOffer: {
              paymentAmountMinor: 100n,
              active: true,
              automaticTopUpEligible: true,
            },
          },
        ],
      },
      chargedThisMonthMinor: 0n,
      latestFundingCreditEntryId: 'entry-a',
      paymentMethodExpired: false,
      secret: 'test-shared-secret',
    });

    expect(attention.map((event) => event.kind)).toEqual(['low_credits']);
  });

  it('refuses a live request if no current authorized recipient remains', () => {
    expect(() => requireBillingFundingRecipients([])).toThrow('BILLING_FUNDING_RECIPIENT_UNAVAILABLE');
  });

  it('rechecks the exact fresh actor, viewer, and payer scope and returns only eligible IDs', async () => {
    const resolveEntitlement = vi.fn().mockResolvedValue({
      payload: { tariff: { usage_billing_enabled: true, payment_collection_enabled: true } },
    });
    const resolveViewer = vi.fn().mockResolvedValue({
      userId: 'member-a',
      organisationId: 'org-a',
      teamId: 'team-a',
      billingManager: false,
    });
    const resolveControlledBy = vi.fn().mockResolvedValue({ can_manage: false });
    const resolveRecipients = vi.fn().mockResolvedValue(['org-manager-a']);
    const resolveCollection = vi.fn().mockResolvedValue({ account: { id: 'stripe-account' } });
    const ensureCreditAccount = vi
      .fn()
      .mockResolvedValue({ id: 'credit-account-a', scope: 'ORGANISATION' });
    const request = {
      product: 'nessie',
      organisationId: 'org-a',
      teamId: 'team-a',
      userId: 'member-a',
    };

    const result = await createBillingCreditFundingRequest(
      {
        request,
        actorToken: 'fresh-actor',
        credential: { id: 'app-key-a' } as never,
        endpoint: '/billing/v1/credits/funding-request' as never,
      },
      {
        prisma: {} as never,
        resolveEntitlement: resolveEntitlement as never,
        resolveViewer: resolveViewer as never,
        resolveControlledBy: resolveControlledBy as never,
        resolveRecipients: resolveRecipients as never,
        resolveCollection: resolveCollection as never,
        ensureCreditAccount: ensureCreditAccount as never,
        now: () => new Date('2026-10-04T12:00:00.000Z'),
        sharedSecret: 'test-shared-secret',
      },
    );

    expect(resolveEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({ request, actorToken: 'fresh-actor', endpoint: '/billing/v1/credits/funding-request' }),
      { prisma: expect.anything() },
    );
    expect(resolveViewer).toHaveBeenCalledWith(
      { userId: 'member-a', organisationId: 'org-a', teamId: 'team-a' },
      { prisma: expect.anything() },
    );
    expect(resolveRecipients).toHaveBeenCalledWith(
      {
        organisationId: 'org-a',
        teamId: 'team-a',
        requesterUserId: 'member-a',
        organisationPays: true,
      },
      { prisma: expect.anything() },
    );
    expect(result).toEqual({
      schema_version: 1,
      request_id: expect.stringMatching(/^bfr1_[a-f0-9]{64}$/),
      recipient_user_ids: ['org-manager-a'],
    });
    expect(JSON.stringify(result)).not.toContain('message');
    expect(resolveCollection).not.toHaveBeenCalled();expect(ensureCreditAccount).not.toHaveBeenCalled();
    expect(resolveControlledBy).not.toHaveBeenCalled();
  });

  it('rejects managers, missing payment collection, or a stale actor before creating a request', async () => {
    const resolveViewer = vi.fn().mockResolvedValue({
      userId: 'manager-a',
      organisationId: 'org-a',
      teamId: 'team-a',
      billingManager: true,
    });
    const shared = {
      prisma: {} as never,
      resolveEntitlement: vi.fn().mockResolvedValue({
        payload: { tariff: { usage_billing_enabled: true, payment_collection_enabled: true } },
      }),
      resolveViewer: resolveViewer as never,
      resolveControlledBy: vi.fn().mockResolvedValue(null) as never,
    };
    const params = {
      request: { product: 'nessie', organisationId: 'org-a', teamId: 'team-a', userId: 'manager-a' },
      actorToken: 'actor',
      credential: { id: 'app-key-a' } as never,
      endpoint: '/billing/v1/credits/funding-request' as never,
    };

    await expect(createBillingCreditFundingRequest(params, shared)).rejects.toThrow(
      'BILLING_FUNDING_REQUEST_NOT_AVAILABLE',
    );
    expect(resolveViewer).toHaveBeenCalledOnce();

    await expect(
      createBillingCreditFundingRequest(params, {
        prisma: {} as never,
        resolveEntitlement: vi.fn().mockResolvedValue({
          payload: { tariff: { usage_billing_enabled: false, payment_collection_enabled: false } },
        }) as never,
        resolveViewer: vi.fn() as never,
      }),
    ).rejects.toThrow('BILLING_FUNDING_REQUEST_NOT_AVAILABLE');

    const resolveViewerAfterStaleActor = vi.fn();
    await expect(
      createBillingCreditFundingRequest(params, {
        prisma: {} as never,
        resolveEntitlement: vi.fn().mockRejectedValue(new Error('stale actor')) as never,
        resolveViewer: resolveViewerAfterStaleActor as never,
      }),
    ).rejects.toThrow('stale actor');
    expect(resolveViewerAfterStaleActor).not.toHaveBeenCalled();
  });
});
