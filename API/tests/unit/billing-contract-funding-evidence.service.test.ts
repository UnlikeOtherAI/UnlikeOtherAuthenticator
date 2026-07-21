import { describe, expect, it, vi } from 'vitest';

import { collectContractFundingEvidence } from '../../src/services/billing-contract-funding-evidence.service.js';

const startsAt = new Date('2026-06-01T00:00:00.000Z');
const endsAt = new Date('2026-07-01T00:00:00.000Z');

function settlement(overrides?: Record<string, unknown>) {
  return {
    id: 'settlement_1',
    serviceId: 'service_1',
    subscriptionId: null,
    creditAccount: {
      accountId: 'stripe_account_1',
      teamId: 'team_1',
      currency: 'USD',
    },
    adjustments: [
      {
        id: 'adjustment_1',
        cumulativeCreditsConsumedMicrocredits: 250_000_000n,
        currentForLines: [],
      },
    ],
    ...overrides,
  };
}

function addon() {
  return {
    id: 'addon_subscription_1',
    serviceId: 'service_1',
    offerId: 'offer_1',
    offerKey: 'privacy',
    catalogId: 'catalog_1',
    scope: 'TEAM',
    initialInvoicePaidAt: new Date('2026-05-31T00:00:00.000Z'),
    initialInvoiceId: 'in_paid_1',
    activationWebhookEventId: 'webhook_1',
    entitlementActivatedAt: new Date('2026-05-31T00:00:00.000Z'),
    service: { identifier: 'deepwater', name: 'DeepWater' },
    offer: {
      id: 'offer_1',
      serviceId: 'service_1',
      key: 'privacy',
      name: 'DeepWater Privacy',
      version: 3,
      monthlyAmountMinor: 5000n,
      currency: 'USD',
    },
    catalog: {
      id: 'catalog_1',
      serviceId: 'service_1',
      offerId: 'offer_1',
      monthlyAmountMinor: 5000n,
      currency: 'USD',
    },
  };
}

function params() {
  return {
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    organisationId: 'org_1',
    billingMonth: '2026-06',
    startsAt,
    endsAt,
  };
}

describe('contract invoice funding evidence', () => {
  it('uses funded settlement consumption and paid add-ons from canonical tables', async () => {
    const settlements = [
      settlement(),
      settlement({
        id: 'settlement_2',
        creditAccount: {
          accountId: 'stripe_account_2',
          teamId: 'team_2',
          currency: 'USD',
        },
        adjustments: [
          {
            id: 'adjustment_2',
            cumulativeCreditsConsumedMicrocredits: 100_000_000n,
            currentForLines: [],
          },
        ],
      }),
    ];
    const prisma = {
      billingCreditUsageSettlement: { findMany: vi.fn().mockResolvedValue(settlements) },
      billingRecurringAddonSubscription: { findMany: vi.fn().mockResolvedValue([addon()]) },
    };

    const result = await collectContractFundingEvidence(params(), { prisma: prisma as never });

    expect(result.credits).toEqual([
      expect.objectContaining({
        settlementId: 'settlement_1',
        adjustmentId: 'adjustment_1',
        creditsAppliedMicrocredits: 250_000_000n,
      }),
      expect.objectContaining({
        settlementId: 'settlement_2',
        adjustmentId: 'adjustment_2',
        creditsAppliedMicrocredits: 100_000_000n,
      }),
    ]);
    expect(result.addons).toEqual([
      {
        serviceId: 'service_1',
        serviceIdentifier: 'deepwater',
        serviceName: 'DeepWater',
        subscriptionId: 'addon_subscription_1',
        offerId: 'offer_1',
        offerVersion: 3,
        catalogId: 'catalog_1',
        offerKey: 'privacy',
        offerName: 'DeepWater Privacy',
        monthlyAmountMinor: 5000n,
        currency: 'USD',
        scope: 'TEAM',
      },
    ]);
    expect(prisma.billingCreditUsageSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tariffId: 'tariff_1',
          billingMonth: '2026-06',
          creditAccount: { orgId: 'org_1', currency: 'USD' },
        }),
      }),
    );
  });

  it('rejects a Stripe credit-line collector for the same usage settlement', async () => {
    const conflict = settlement({
      adjustments: [
        {
          id: 'adjustment_1',
          cumulativeCreditsConsumedMicrocredits: 250_000_000n,
          currentForLines: [{ id: 'stripe_line_1' }],
        },
      ],
    });
    const prisma = {
      billingCreditUsageSettlement: { findMany: vi.fn().mockResolvedValue([conflict]) },
      billingRecurringAddonSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await expect(
      collectContractFundingEvidence(params(), { prisma: prisma as never }),
    ).rejects.toThrow('BILLING_INVOICE_CREDIT_COLLECTOR_CONFLICT');
  });

  it('rejects multiple credit accounts for the same exact team', async () => {
    const prisma = {
      billingCreditUsageSettlement: {
        findMany: vi.fn().mockResolvedValue([
          settlement(),
          settlement({
            id: 'settlement_2',
            creditAccount: {
              accountId: 'stripe_account_2',
              teamId: 'team_1',
              currency: 'USD',
            },
          }),
        ]),
      },
      billingRecurringAddonSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await expect(
      collectContractFundingEvidence(params(), { prisma: prisma as never }),
    ).rejects.toThrow('BILLING_INVOICE_CREDIT_ACCOUNT_AMBIGUOUS');
  });
});
