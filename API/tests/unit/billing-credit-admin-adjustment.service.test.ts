import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createAdminCreditAdjustment } from '../../src/services/billing-credit-admin-adjustment.service.js';

const createdAt = new Date('2026-07-21T12:00:00.000Z');
const adjustment = {
  id: 'bca_adjustment',
  signedAmountMicrocredits: 1_250_000n,
  reason: 'Restore the exact balance after a test run',
  idempotencyKey: 'restore.test-run-42',
  createdByUserId: 'user_admin',
  createdByEmail: 'admin@example.com',
  createdByAdminDomain: 'admin.example.com',
  createdAt,
};

function accountRow(balanceMicrocredits = 3_250_000n) {
  return {
    id: 'credit_account',
    accountId: 'stripe_account_row',
    orgId: 'org_1',
    teamId: 'team_1',
    currency: 'USD',
    balanceMicrocredits,
    updatedAt: createdAt,
    account: { livemode: false },
    org: { id: 'org_1', name: 'Acme' },
    team: { id: 'team_1', name: 'Research' },
    adminAdjustments: [adjustment],
  };
}

function input(overrides: Partial<Parameters<typeof createAdminCreditAdjustment>[0]> = {}) {
  return {
    creditAccountId: 'credit_account',
    organisationId: 'org_1',
    teamId: 'team_1',
    signedCredits: '1.25',
    reason: adjustment.reason,
    idempotencyKey: adjustment.idempotencyKey,
    actor: { userId: 'user_admin', email: 'admin@example.com' },
    ...overrides,
  };
}

function transactionHarness(options: {
  existing?: typeof adjustment | null;
  account?: ReturnType<typeof accountRow>;
}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    billingCreditAccount: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({
          accountId: 'stripe_account_row',
          orgId: 'org_1',
          teamId: 'team_1',
          currency: 'USD',
        })
        .mockResolvedValue(options.account ?? accountRow()),
    },
    billingCreditAdminAdjustment: {
      findUnique: vi.fn().mockResolvedValue(options.existing ?? null),
      create: vi.fn().mockResolvedValue(adjustment),
    },
    billingCreditEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn(
    async (
      run: (value: typeof tx) => Promise<unknown>,
      config: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => {
      expect(config.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable);
      return run(tx);
    },
  );
  return { tx, prisma: { $transaction: transaction }, transaction };
}

describe('superuser credit adjustments', () => {
  it('commits immutable evidence, the exact ledger entry, and one audit record', async () => {
    const harness = transactionHarness({});
    const ids = ['adjustment', 'entry'];
    const result = await createAdminCreditAdjustment(input(), {
      prisma: harness.prisma as never,
      adminDomain: 'ADMIN.EXAMPLE.COM.',
      now: () => createdAt,
      createId: () => ids.shift()!,
      lockBalance: vi.fn().mockResolvedValue(2_000_000n),
    });

    expect(result).toMatchObject({
      replayed: false,
      account: {
        id: 'credit_account',
        mode: 'test',
        remaining_credits: { credits: '3.25', usd_equivalent: { amount: '0.00325' } },
      },
      adjustment: { signed_credits: { credits: '1.25' } },
    });
    expect(harness.tx.billingCreditAdminAdjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: 'bca_adjustment',
          creditEntryId: 'bce_entry',
          signedAmountMicrocredits: 1_250_000n,
          createdByAdminDomain: 'admin.example.com',
        }),
      }),
    );
    expect(harness.tx.billingCreditEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'bce_entry',
        direction: 'CREDIT',
        kind: 'ADJUSTMENT',
        amountMicrocredits: 1_250_000n,
        balanceAfterMicrocredits: 3_250_000n,
        sourceType: 'credit_admin_adjustment',
        sourceId: 'bca_adjustment',
      }),
    });
    expect(harness.tx.adminAuditLog.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'billing.credit_adjustment_created',
        metadata: expect.objectContaining({
          signed_credits: expect.objectContaining({ credits: '1.25' }),
        }),
      }),
    });
  });

  it('returns an exact same-account replay without a second entry or audit', async () => {
    const harness = transactionHarness({ existing: adjustment });
    const result = await createAdminCreditAdjustment(input(), {
      prisma: harness.prisma as never,
      adminDomain: 'admin.example.com',
      lockBalance: vi.fn().mockResolvedValue(3_250_000n),
    });

    expect(result.replayed).toBe(true);
    expect(result.adjustment.id).toBe(adjustment.id);
    expect(harness.tx.billingCreditAdminAdjustment.create).not.toHaveBeenCalled();
    expect(harness.tx.billingCreditEntry.create).not.toHaveBeenCalled();
    expect(harness.tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key with changed immutable intent', async () => {
    const harness = transactionHarness({ existing: adjustment });
    await expect(
      createAdminCreditAdjustment(input({ reason: 'A different reason' }), {
        prisma: harness.prisma as never,
        adminDomain: 'admin.example.com',
        lockBalance: vi.fn().mockResolvedValue(3_250_000n),
      }),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
    expect(harness.tx.billingCreditEntry.create).not.toHaveBeenCalled();
  });

  it('rejects a key already occupied by another credit-entry source', async () => {
    const harness = transactionHarness({ existing: null });
    harness.tx.billingCreditEntry.findUnique.mockResolvedValue({ id: 'top_up_entry' });
    await expect(
      createAdminCreditAdjustment(input(), {
        prisma: harness.prisma as never,
        adminDomain: 'admin.example.com',
        lockBalance: vi.fn().mockResolvedValue(3_250_000n),
      }),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
    expect(harness.tx.billingCreditAdminAdjustment.create).not.toHaveBeenCalled();
  });

  it('does not let an administrative debit create or worsen debt', async () => {
    const harness = transactionHarness({ existing: null });
    await expect(
      createAdminCreditAdjustment(input({ signedCredits: '-2.00001' }), {
        prisma: harness.prisma as never,
        adminDomain: 'admin.example.com',
        lockBalance: vi.fn().mockResolvedValue(2_000_000n),
      }),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_INSUFFICIENT');
    expect(harness.tx.billingCreditAdminAdjustment.create).not.toHaveBeenCalled();
  });

  it.each(['0', '-0', '1.000001', '+1', '01', '9223372036854.77581'])(
    'rejects an unsupported signed credit amount: %s',
    async (signedCredits) => {
      await expect(
        createAdminCreditAdjustment(input({ signedCredits }), {
          prisma: {} as never,
          adminDomain: 'admin.example.com',
        }),
      ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_AMOUNT_INVALID');
    },
  );
});
