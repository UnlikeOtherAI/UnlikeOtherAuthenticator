import { BillingCreditAutoTopUpState, BillingCreditCheckoutStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createBillingCreditAutoTopUpSetup } from '../../src/services/billing-credit-auto-top-up-setup.service.js';

const credential = {
  id: 'app_key_1',
  checkoutReturnOrigins: ['https://app.example'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};

describe('automatic top-up Setup Checkout finalization', () => {
  it('does not reopen a setup invalidated while Stripe creates its session', async () => {
    const sessionCreate = vi.fn().mockImplementation(async (input) => ({
      id: 'cs_setup_race',
      livemode: false,
      mode: 'setup',
      status: 'open',
      url: 'https://checkout.stripe.com/c/setup/cs_setup_race',
      customer: input.customer,
      client_reference_id: input.client_reference_id,
      metadata: input.metadata,
      expires_at: 1_784_470_800,
    }));
    const context = {
      actor: { jti: 'actor_setup_race' },
      account: { id: 'account_1', stripeAccountId: 'acct_1', livemode: false },
      creditAccount: {
        id: 'credit_account_1',
        autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
        autoTopUpGeneration: 3,
        autoTopUpConsentRevisionId: null,
        stripePaymentMethodId: null,
      },
      customer: { id: 'customer_1', stripeCustomerId: 'cus_1' },
      stripe: { checkout: { sessions: { create: sessionCreate } } },
    };
    const selection = {
      policy: { id: 'policy_1', automaticConsentVersion: 'consent-v1' },
      option: {
        id: 'option_1',
        thresholdMicrocredits: 5_000_000_000n,
        monthlyChargeCapMinor: 10_000n,
      },
      offer: {
        id: 'offer_1',
        paymentAmountMinor: 2_500n,
        creditsReceivedMicrocredits: 25_000_000_000n,
      },
      catalog: { id: 'catalog_1' },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      billingCreditSetupCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'setup_race', ...data })),
        updateMany,
      },
    };

    await expect(
      createBillingCreditAutoTopUpSetup(
        {
          request: {
            product: 'deepwater',
            organisationId: 'org_1',
            teamId: 'team_1',
            userId: 'user_1',
            optionId: selection.option.id,
          },
          actorToken: 'actor',
          credential: credential as never,
        },
        {
          prisma: prisma as never,
          resolveContext: vi.fn().mockResolvedValue(context),
          resolveOption: vi.fn().mockResolvedValue(selection),
          validateCatalog: vi.fn(),
          afterStripeSessionCreated: vi.fn(),
        },
      ),
    ).rejects.toThrow('BILLING_CREDIT_SETUP_PREDECESSOR_CHANGED');
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'setup_race',
        status: BillingCreditCheckoutStatus.CREATING,
        expectedGeneration: 3,
        expectedConsentRevisionId: null,
      },
      data: expect.objectContaining({
        stripeCheckoutSessionId: 'cs_setup_race',
        status: BillingCreditCheckoutStatus.OPEN,
      }),
    });
  });
});
