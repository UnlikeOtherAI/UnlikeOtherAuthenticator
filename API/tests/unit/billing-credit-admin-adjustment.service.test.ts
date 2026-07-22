import { BillingCreditAutoTopUpState, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  createAdminCreditAdjustment,
  previewAdminCreditAdjustment,
} from '../../src/services/billing-credit-admin-adjustment.service.js';
import { signCreditAdjustmentConfirmation } from '../../src/services/billing-credit-admin-adjustment-token.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');
const secret = 'admin-confirmation-secret-at-least-32-characters';
const actor = { userId: 'user_admin', email: 'admin@example.com' };
const reason = 'Restore the exact balance after a test run';

const adjustment = {
  id: 'bca_adjustment',
  signedAmountMicrocredits: 1_250_000n,
  reason,
  idempotencyKey: 'restore.test-run-42',
  createdByUserId: actor.userId,
  createdByEmail: actor.email,
  createdByAdminDomain: 'admin.example.com',
  createdAt: now,
};

function accountRow(balanceMicrocredits = 2_000_000n) {
  return {
    id: 'credit_account',
    accountId: 'billing_account_row',
    orgId: 'org_1',
    teamId: 'team_1',
    currency: 'USD',
    balanceMicrocredits,
    autoTopUpGeneration: 0,
    autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
    autoTopUpThresholdMicrocredits: null,
    updatedAt: now,
    account: { livemode: false },
    org: { id: 'org_1', name: 'Acme' },
    team: { id: 'team_1', name: 'Research' },
    autoTopUpConsentRevision: null,
    adminAdjustments: [adjustment],
  };
}

function intent(signedCredits = '1.25') {
  return {
    creditAccountId: 'credit_account',
    organisationId: 'org_1',
    teamId: 'team_1',
    signedCredits,
    reason,
    idempotencyKey: adjustment.idempotencyKey,
    actor,
  };
}

function harness(params: {
  accounts?: ReturnType<typeof accountRow>[];
  existing?: (typeof adjustment & { creditEntry: { balanceAfterMicrocredits: bigint } }) | null;
  unresolved?: boolean;
}) {
  const accountFind = vi.fn();
  for (const account of params.accounts ?? [accountRow()])
    accountFind.mockResolvedValueOnce(account);
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    billingCreditAccount: { findUnique: accountFind },
    billingCreditAutoTopUpAttempt: {
      findFirst: vi.fn().mockResolvedValue(params.unresolved ? { id: 'attempt_open' } : null),
    },
    billingCreditAdminAdjustment: {
      findUnique: vi.fn().mockResolvedValue(params.existing ?? null),
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
      expect(config.isolationLevel).toBe(Prisma.TransactionIsolationLevel.ReadCommitted);
      return run(tx);
    },
  );
  return { tx, prisma: { $transaction: transaction }, transaction };
}

async function confirmationToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return (
    await signCreditAdjustmentConfirmation({
      snapshot: {
        actor_user_id: actor.userId,
        actor_email: actor.email,
        admin_domain: 'admin.example.com',
        credit_account_id: 'credit_account',
        organisation_id: 'org_1',
        team_id: 'team_1',
        mode: 'test',
        current_credits: '2',
        resulting_credits: '3.25',
        signed_credits: '1.25',
        reason,
        idempotency_key: adjustment.idempotencyKey,
        automatic_top_up: {
          generation: 0,
          state: 'disabled',
          threshold_credits: null,
          refill_credits: null,
          consequence: 'not_active',
        },
        ...overrides,
      },
      secret,
      audience: 'admin.example.com',
      now,
    })
  ).confirmation_token;
}

const deps = {
  adminDomain: 'ADMIN.EXAMPLE.COM.',
  confirmationSecret: secret,
  now: () => now,
};

describe('superuser credit adjustment confirmation', () => {
  it('creates a short-lived server preview with exact balances and automatic top-up consequence', async () => {
    const test = harness({ accounts: [accountRow()] });
    const preview = await previewAdminCreditAdjustment(intent(), {
      ...deps,
      prisma: test.prisma as never,
      lockAccount: vi.fn().mockResolvedValue(2_000_000n),
    });

    expect(preview).toMatchObject({
      account: { id: 'credit_account', organisation: { id: 'org_1' }, team: { id: 'team_1' } },
      current_credits: { credits: '2' },
      signed_credits: { credits: '1.25' },
      resulting_credits: { credits: '3.25' },
      automatic_top_up: { generation: 0, state: 'disabled', consequence: { code: 'not_active' } },
      expires_at: '2026-07-21T12:02:00.000Z',
    });
    expect(preview.confirmation_token.split('.')).toHaveLength(3);
  });

  it('transactionally revalidates the token and commits one exact entry and audit', async () => {
    const test = harness({ accounts: [accountRow(), accountRow(3_250_000n)] });
    const ids = ['adjustment', 'entry'];
    const result = await createAdminCreditAdjustment(
      { creditAccountId: 'credit_account', confirmationToken: await confirmationToken(), actor },
      {
        ...deps,
        prisma: test.prisma as never,
        createId: () => ids.shift()!,
        lockAccount: vi.fn().mockResolvedValue(2_000_000n),
      },
    );

    expect(result).toMatchObject({
      replayed: false,
      account: { remaining_credits: { credits: '3.25' } },
      adjustment: { signed_credits: { credits: '1.25' } },
    });
    expect(test.tx.billingCreditEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        direction: 'CREDIT',
        kind: 'ADJUSTMENT',
        amountMicrocredits: 1_250_000n,
        balanceAfterMicrocredits: 3_250_000n,
      }),
    });
    expect(test.tx.adminAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('returns the original adjustment before considering a newer unresolved top-up attempt', async () => {
    const existing = { ...adjustment, creditEntry: { balanceAfterMicrocredits: 3_250_000n } };
    const test = harness({
      accounts: [accountRow(4_000_000n), accountRow(4_000_000n)],
      existing,
      unresolved: true,
    });
    const result = await createAdminCreditAdjustment(
      { creditAccountId: 'credit_account', confirmationToken: await confirmationToken(), actor },
      {
        ...deps,
        prisma: test.prisma as never,
        lockAccount: vi.fn().mockResolvedValue(4_000_000n),
      },
    );

    expect(result).toMatchObject({
      replayed: true,
      adjustment: { id: adjustment.id },
      account: { remaining_credits: { credits: '4' } },
    });
    expect(test.tx.billingCreditAutoTopUpAttempt.findFirst).not.toHaveBeenCalled();
    expect(test.tx.billingCreditEntry.create).not.toHaveBeenCalled();
    expect(test.tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects changed intent for an existing key before considering an unresolved attempt', async () => {
    const existing = { ...adjustment, creditEntry: { balanceAfterMicrocredits: 3_250_000n } };
    const test = harness({ accounts: [accountRow(4_000_000n)], existing, unresolved: true });

    await expect(
      createAdminCreditAdjustment(
        {
          creditAccountId: 'credit_account',
          confirmationToken: await confirmationToken({ reason: 'Different operator intent' }),
          actor,
        },
        {
          ...deps,
          prisma: test.prisma as never,
          lockAccount: vi.fn().mockResolvedValue(4_000_000n),
        },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
    expect(test.tx.billingCreditAutoTopUpAttempt.findFirst).not.toHaveBeenCalled();
    expect(test.tx.billingCreditEntry.create).not.toHaveBeenCalled();
    expect(test.tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects stale balance or automatic-top-up snapshots before writing', async () => {
    const test = harness({ accounts: [accountRow(2_100_000n)] });
    await expect(
      createAdminCreditAdjustment(
        { creditAccountId: 'credit_account', confirmationToken: await confirmationToken(), actor },
        {
          ...deps,
          prisma: test.prisma as never,
          lockAccount: vi.fn().mockResolvedValue(2_100_000n),
        },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_STALE');
    expect(test.tx.billingCreditAdminAdjustment.create).not.toHaveBeenCalled();
  });

  it('rejects a confirmation after the automatic-top-up generation changes', async () => {
    const changed = { ...accountRow(), autoTopUpGeneration: 1 };
    const test = harness({ accounts: [changed] });
    await expect(
      createAdminCreditAdjustment(
        { creditAccountId: 'credit_account', confirmationToken: await confirmationToken(), actor },
        {
          ...deps,
          prisma: test.prisma as never,
          lockAccount: vi.fn().mockResolvedValue(2_000_000n),
        },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_STALE');
  });

  it('rejects an expired or tampered server confirmation', async () => {
    const token = await confirmationToken();
    const [header, payload, signature] = token.split('.');
    await expect(
      createAdminCreditAdjustment(
        {
          creditAccountId: 'credit_account',
          confirmationToken: `${header}.${payload}x.${signature}`,
          actor,
        },
        deps,
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_INVALID');
    await expect(
      createAdminCreditAdjustment(
        { creditAccountId: 'credit_account', confirmationToken: token, actor },
        { ...deps, now: () => new Date('2026-07-21T12:03:00.000Z') },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_INVALID');
  });

  it('rejects under the account lock while an automatic top-up attempt is unresolved', async () => {
    const test = harness({ accounts: [accountRow()], unresolved: true });
    await expect(
      previewAdminCreditAdjustment(intent(), {
        ...deps,
        prisma: test.prisma as never,
        lockAccount: vi.fn().mockResolvedValue(2_000_000n),
      }),
    ).rejects.toThrowError('BILLING_CREDIT_ADJUSTMENT_AUTO_TOP_UP_PENDING');
  });

  it('maps a missing locked account to a safe not-found response', async () => {
    const test = harness({});
    await expect(
      previewAdminCreditAdjustment(intent(), {
        ...deps,
        prisma: test.prisma as never,
        lockAccount: vi.fn().mockResolvedValue(null),
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'BILLING_CREDIT_ACCOUNT_NOT_FOUND' });
  });

  it('maps an account that disappears after its lock to a safe conflict', async () => {
    const test = harness({ accounts: [] });
    await expect(
      previewAdminCreditAdjustment(intent(), {
        ...deps,
        prisma: test.prisma as never,
        lockAccount: vi.fn().mockResolvedValue(2_000_000n),
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'BILLING_CREDIT_ACCOUNT_STALE' });
  });

  it.each(['0', '-0', '1.000001', '+1', '01', '9223372036854.77581'])(
    'rejects an unsupported signed credit amount: %s',
    async (signedCredits) => {
      await expect(previewAdminCreditAdjustment(intent(signedCredits), deps)).rejects.toThrowError(
        'BILLING_CREDIT_ADJUSTMENT_AMOUNT_INVALID',
      );
    },
  );
});
