import { BillingAppKeyPurpose } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { BILLING_CUSTOMER_ACTION } from '../../src/services/billing-customer-action-intent.service.js';
import {
  assertCreditCatalogPrice,
  resolveCreditFundingActionContext,
} from '../../src/services/billing-credit-funding-context.service.js';

const account = { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false };
const catalog = {
  stripeLookupKey: 'uoa-credits-20k-v1',
  stripeProductId: 'prod_credits_20k',
  stripePriceId: 'price_credits_20k',
  paymentAmountMinor: 2_000n,
  creditsReceivedMicrocredits: 20_000_000_000n,
};

function remotePrice(amount = 2_000) {
  return {
    id: catalog.stripePriceId,
    livemode: false,
    active: true,
    type: 'one_time',
    currency: 'usd',
    unit_amount: amount,
    lookup_key: catalog.stripeLookupKey,
    metadata: {
      credits: '20000',
      uoa_kind: 'team_credit_top_up',
    },
    product: {
      id: catalog.stripeProductId,
      livemode: false,
      active: true,
      metadata: {
        contract_version: '1',
        credits_per_usd: '1000',
        uoa_kind: 'team_credits',
      },
    },
  };
}

describe('credit funding Stripe catalog verification', () => {
  it('accepts only the exact active account/mode product, lookup key, and fixed amount', async () => {
    const retrieve = vi.fn().mockResolvedValue(remotePrice());

    await assertCreditCatalogPrice({ prices: { retrieve } } as never, account, catalog);

    expect(retrieve).toHaveBeenCalledWith(catalog.stripePriceId, { expand: ['product'] });
  });

  it('fails closed when the current Stripe Price amount drifts from UOA policy', async () => {
    await expect(
      assertCreditCatalogPrice(
        { prices: { retrieve: vi.fn().mockResolvedValue(remotePrice(1)) } } as never,
        account,
        catalog,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_CATALOG_BINDING_INVALID');
  });

  it('defers authority evidence and remote customer effects until domain validation succeeds', async () => {
    const authorizeAction = vi.fn().mockRejectedValue(new Error('authority revoked'));
    const ensureCustomer = vi.fn();
    const customer = {
      id: 'customer_1',
      scope: 'TEAM',
      scopeKey: 'team_1',
      stripeCustomerId: null,
    };
    const prisma = {
      billingStripeCustomer: { findUnique: vi.fn().mockResolvedValue(customer) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user_1', email: 'a@example.com' }) },
      organisation: { findUnique: vi.fn().mockResolvedValue({ id: 'org_1', name: 'Org' }) },
      team: { findFirst: vi.fn().mockResolvedValue({ id: 'team_1', name: 'Team' }) },
    };
    const credential = {
      id: 'app_key_1',
      purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      actorIssuer: 'https://app.example',
      actorAudience: 'https://authentication.example/billing',
      actorKeyId: 'key_1',
      actorPublicJwk: {},
      checkoutReturnOrigins: ['https://app.example'],
      service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
    };

    const context = await resolveCreditFundingActionContext(
      {
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
        actorToken: 'actor',
        credential,
        action: {
          operation: BILLING_CUSTOMER_ACTION.CREDIT_TOP_UP,
          request: { offer_id: 'offer_1' },
        },
      },
      {
        prisma: prisma as never,
        stripe: {} as never,
        resolveTariff: vi
          .fn()
          .mockResolvedValue({ actor: { jti: 'actor_1', tv: 2, exp: 2_000_000_000 } }) as never,
        resolveViewer: vi.fn().mockResolvedValue({ billingManager: true }) as never,
        authorizeAction: authorizeAction as never,
        resolveAccount: vi.fn().mockResolvedValue(account) as never,
        ensureCreditAccount: vi.fn().mockResolvedValue({
          id: 'credit_1',
          customerId: customer.id,
        }) as never,
        ensureCustomer: ensureCustomer as never,
      },
    );
    expect(authorizeAction).not.toHaveBeenCalled();
    expect(ensureCustomer).not.toHaveBeenCalled();

    await expect(context.authorizeAction()).rejects.toThrow('authority revoked');
    expect(ensureCustomer).not.toHaveBeenCalled();
  });
});
