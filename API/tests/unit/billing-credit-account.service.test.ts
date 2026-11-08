import type { PrismaClient } from '@prisma/client';
import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCreditCollectionContext } from '../../src/services/billing-credit-account.service.js';

const subject = { organisationId: 'org_1', teamId: 'team_1' };
const account = { id: 'account_1', stripeAccountId: 'acct_persisted', livemode: false };
const originalGate = process.env.STRIPE_BILLING_ENABLED;
const epoch='2026-11-08T00:00:00.000Z';
beforeEach(()=>{vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID',account.stripeAccountId);
  vi.stubEnv('STRIPE_SANDBOX_SECRET_KEY','rk_test_synthetic');vi.stubEnv('STRIPE_SANDBOX_WEBHOOK_SECRET','whsec_synthetic');});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalGate === undefined) delete process.env.STRIPE_BILLING_ENABLED;
  else process.env.STRIPE_BILLING_ENABLED = originalGate;
});

function database(scoped: unknown[], persisted: unknown[] = []) {
  return {
    team: { findFirst: vi.fn().mockResolvedValue({ id: subject.teamId }) },
    organisation:{findFirst:vi.fn().mockResolvedValue({id:subject.organisationId})},
    $queryRaw:vi.fn().mockResolvedValue([{sandbox:true,revision:1,epoch:new Date(epoch)}]),
    billingCreditAccount: { findMany: vi.fn().mockResolvedValue(scoped) },
    billingStripeAccount: { findMany: vi.fn().mockResolvedValue(persisted) },
  } as unknown as PrismaClient;
}

describe('credit collection account resolution with Stripe disabled', () => {
  it('uses the exact persisted ORG account under the named mode without another account lookup', async () => {
    process.env.STRIPE_BILLING_ENABLED = 'false';
    const prisma = database([{ account }], [account, { ...account, id: 'account_other' }]);

    await expect(resolveCreditCollectionContext(subject, { prisma })).resolves.toEqual({
      account, modeRevision: 1,scopeEpoch:epoch,
      stripeCollectionEnabled: false,
      stripe: null,
    });
    expect(prisma.billingStripeAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.billingCreditAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({orgId:subject.organisationId,
      scope:'ORGANISATION',teamId:null,account:{stripeAccountId:account.stripeAccountId,livemode:false}})}));
  });

  it('uses the exact named account when the ORG wallet is not provisioned yet', async () => {
    process.env.STRIPE_BILLING_ENABLED = 'false';
    const prisma = database([], [account]);

    await expect(resolveCreditCollectionContext(subject, { prisma })).resolves.toMatchObject({
      account, modeRevision: 1,
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
