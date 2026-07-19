import { BillingAssignmentScope, BillingTariffSource } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  assertDefaultTariffChangeAllowed,
  assertTariffAssignmentChangeAllowed,
  assertTariffAssignmentRemovalAllowed,
} from '../../src/services/billing-stripe-tariff-guard.service.js';

function transactionClient(params?: {
  checkout?: { id: string } | null;
  subscription?: { id: string } | null;
}) {
  return {
    billingStripeCheckoutSession: {
      findFirst: vi.fn().mockResolvedValue(params?.checkout ?? null),
    },
    billingStripeSubscription: {
      findFirst: vi.fn().mockResolvedValue(params?.subscription ?? null),
    },
  };
}

describe('Stripe tariff pin guards', () => {
  it('rejects replacing a default pinned by a live subscription', async () => {
    const tx = transactionClient({ subscription: { id: 'subscription_1' } });

    await expect(
      assertDefaultTariffChangeAllowed(tx as never, 'service_1', 'new_tariff'),
    ).rejects.toThrow('STRIPE_TARIFF_PINNED');

    expect(tx.billingStripeSubscription.findFirst).toHaveBeenCalledWith({
      where: {
        serviceId: 'service_1',
        tariffSource: BillingTariffSource.SERVICE_DEFAULT,
        tariffId: { not: 'new_tariff' },
        status: { notIn: ['canceled', 'incomplete_expired'] },
      },
      select: { id: true },
    });
  });

  it('rejects a team assignment under an organisation subscription', async () => {
    const tx = transactionClient({ subscription: { id: 'subscription_1' } });

    await expect(
      assertTariffAssignmentChangeAllowed(tx as never, {
        serviceId: 'service_1',
        orgId: 'org_1',
        teamId: 'team_1',
        targetTariffId: 'tariff_1',
        currentAssignmentId: null,
      }),
    ).rejects.toThrow('STRIPE_TARIFF_PINNED');

    expect(tx.billingStripeSubscription.findFirst).toHaveBeenCalledWith({
      where: {
        serviceId: 'service_1',
        orgId: 'org_1',
        scope: BillingAssignmentScope.ORGANISATION,
        status: { notIn: ['canceled', 'incomplete_expired'] },
      },
      select: { id: true },
    });
  });

  it('rejects removing an assignment pinned by an open checkout', async () => {
    const tx = transactionClient({ checkout: { id: 'checkout_1' } });

    await expect(assertTariffAssignmentRemovalAllowed(tx as never, 'assignment_1')).rejects.toThrow(
      'STRIPE_TARIFF_PINNED',
    );
  });

  it('allows changes when terminal rows are excluded from the live-row queries', async () => {
    const tx = transactionClient();

    await expect(
      assertTariffAssignmentRemovalAllowed(tx as never, 'assignment_1'),
    ).resolves.toBeUndefined();

    expect(tx.billingStripeCheckoutSession.findFirst).toHaveBeenCalledWith({
      where: {
        tariffAssignmentId: 'assignment_1',
        status: { in: ['creating', 'open'] },
      },
      select: { id: true },
    });
    expect(tx.billingStripeSubscription.findFirst).toHaveBeenCalledWith({
      where: {
        tariffAssignmentId: 'assignment_1',
        status: { notIn: ['canceled', 'incomplete_expired'] },
      },
      select: { id: true },
    });
  });
});
