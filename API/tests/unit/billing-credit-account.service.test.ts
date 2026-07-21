import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCreditCollectionContext } from '../../src/services/billing-credit-account.service.js';

const subject = { organisationId: 'org_1', teamId: 'team_1' };
const account = { id: 'account_1', stripeAccountId: 'acct_persisted', livemode: false };
const originalGate = process.env.STRIPE_BILLING_ENABLED;

afterEach(() => {
  if (originalGate === undefined) delete process.env.STRIPE_BILLING_ENABLED;
  else process.env.STRIPE_BILLING_ENABLED = originalGate;
});

function database(scoped: unknown[], persisted: unknown[] = []) {
  return {
    billingCreditAccount: { findMany: vi.fn().mockResolvedValue(scoped) },
    billingStripeAccount: { findMany: vi.fn().mockResolvedValue(persisted) },
  } as unknown as PrismaClient;
}

describe('credit collection account resolution with Stripe disabled', () => {
  it('uses the one exact persisted team account without touching global account selection', async () => {
    process.env.STRIPE_BILLING_ENABLED = 'false';
    const prisma = database([{ account }], [account, { ...account, id: 'account_other' }]);

    await expect(resolveCreditCollectionContext(subject, { prisma })).resolves.toEqual({
      account,
      stripeCollectionEnabled: false,
      stripe: null,
    });
    expect(prisma.billingStripeAccount.findMany).not.toHaveBeenCalled();
  });

  it('uses one unambiguous persisted account when the team account is not provisioned yet', async () => {
    process.env.STRIPE_BILLING_ENABLED = 'false';
    const prisma = database([], [account]);

    await expect(resolveCreditCollectionContext(subject, { prisma })).resolves.toMatchObject({
      account,
      stripeCollectionEnabled: false,
    });
  });

  it.each([
    { scoped: [], persisted: [], code: 'BILLING_CREDIT_ACCOUNT_NOT_PROVISIONED' },
    {
      scoped: [],
      persisted: [account, { ...account, id: 'account_2', stripeAccountId: 'acct_2' }],
      code: 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS',
    },
    {
      scoped: [{ account }, { account: { ...account, id: 'account_2' } }],
      persisted: [],
      code: 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS',
    },
  ])(
    'fails closed for an ambiguous or absent persisted mode',
    async ({ scoped, persisted, code }) => {
      process.env.STRIPE_BILLING_ENABLED = 'false';
      await expect(
        resolveCreditCollectionContext(subject, { prisma: database(scoped, persisted) }),
      ).rejects.toThrow(code);
    },
  );
});
