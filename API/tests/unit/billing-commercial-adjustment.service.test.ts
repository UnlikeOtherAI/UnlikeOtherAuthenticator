import {
  BillingAdjustmentCadence,
  BillingAdjustmentKind,
  BillingAssignmentScope,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  createCommercialAdjustment,
  deactivateCommercialAdjustment,
  listApplicableCommercialAdjustments,
} from '../../src/services/billing-commercial-adjustment.service.js';

function setup() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'adjustment_1',
    ...data,
  }));
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockResolvedValue([]);
  const auditCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    billingService: {
      findFirst: vi.fn().mockResolvedValue({ id: 'service_1' }),
    },
    organisation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org_1' }),
    },
    team: {
      findFirst: vi.fn().mockResolvedValue({ id: 'team_1' }),
    },
    billingCommercialAdjustment: {
      create,
      findMany,
      updateMany,
    },
    adminAuditLog: { create: auditCreate },
    $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) => run(prisma)),
  };
  return { prisma, create, findMany, updateMany, auditCreate };
}

describe('UOA commercial adjustments', () => {
  it('persists an exact scoped add-on and audits the commercial mutation', async () => {
    const { prisma, create, auditCreate } = setup();
    const result = await createCommercialAdjustment(
      {
        serviceId: 'service_1',
        organisationId: 'org_1',
        teamId: 'team_1',
        key: 'Priority-Support',
        name: 'Priority support',
        kind: 'add_on',
        cadence: 'monthly',
        amountMinor: '1000',
        currency: 'gbp',
        startsAt: new Date('2026-07-01T00:00:00.000Z'),
        createdBy: { userId: 'user_admin', email: 'admin@example.com' },
      },
      { prisma: prisma as never },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: BillingAssignmentScope.TEAM,
        scopeKey: 'org_1:team_1',
        key: 'priority-support',
        kind: BillingAdjustmentKind.ADD_ON,
        cadence: BillingAdjustmentCadence.MONTHLY,
        amountMinor: 1000n,
        currency: 'GBP',
      }),
    });
    expect(result).toMatchObject({ id: 'adjustment_1', amountMinor: 1000n });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorEmail: 'admin@example.com',
        action: 'billing.commercial_adjustment_created',
        metadata: expect.objectContaining({
          adjustment_id: 'adjustment_1',
          amount_minor: '1000',
        }),
      }),
    });
  });

  it('rejects malformed or out-of-scope value before writing', async () => {
    const { prisma, create } = setup();
    await expect(
      createCommercialAdjustment(
        {
          serviceId: 'service_1',
          organisationId: 'org_1',
          key: 'credit',
          name: 'Credit',
          kind: 'credit',
          cadence: 'one_time',
          amountMinor: '-1',
          currency: 'GBP',
          startsAt: new Date('2026-07-01T00:00:00.000Z'),
        },
        { prisma: prisma as never },
      ),
    ).rejects.toThrow('BILLING_ADJUSTMENT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it('deactivates rather than deleting history and records the operator', async () => {
    const { prisma, updateMany, auditCreate } = setup();
    const deactivatedAt = new Date('2026-07-20T12:00:00.000Z');
    await deactivateCommercialAdjustment(
      {
        serviceId: 'service_1',
        adjustmentId: 'adjustment_1',
        actor: { email: 'admin@example.com' },
      },
      { prisma: prisma as never, now: () => deactivatedAt },
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'adjustment_1',
        serviceId: 'service_1',
        active: true,
      },
      data: { active: false, deactivatedAt },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'billing.commercial_adjustment_deactivated',
      }),
    });
  });

  it('preserves already-effective lines in historical statements after deactivation', async () => {
    const { prisma, findMany } = setup();
    findMany.mockResolvedValue([
      {
        id: 'monthly',
        cadence: BillingAdjustmentCadence.MONTHLY,
        active: false,
        startsAt: new Date('2026-06-01T00:00:00.000Z'),
        deactivatedAt: new Date('2026-07-15T00:00:00.000Z'),
      },
      {
        id: 'used_once',
        cadence: BillingAdjustmentCadence.ONE_TIME,
        active: false,
        startsAt: new Date('2026-07-05T00:00:00.000Z'),
        deactivatedAt: new Date('2026-07-10T00:00:00.000Z'),
      },
      {
        id: 'cancelled_before_use',
        cadence: BillingAdjustmentCadence.ONE_TIME,
        active: false,
        startsAt: new Date('2026-07-20T00:00:00.000Z'),
        deactivatedAt: new Date('2026-07-10T00:00:00.000Z'),
      },
    ]);

    const result = await listApplicableCommercialAdjustments(
      {
        serviceId: 'service_1',
        organisationId: 'org_1',
        teamId: 'team_1',
        startsAt: new Date('2026-07-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      { prisma: prisma as never },
    );

    expect(result.map((row) => row.id)).toEqual(['monthly', 'used_once']);
  });
});
