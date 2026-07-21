import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  BillingCreditAutoTopUpConsentSource,
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
  MembershipStatus,
  type BillingCreditAccount,
  type PrismaClient,
} from '@prisma/client';
import { vi } from 'vitest';

import type { CreditFundingActionContext } from '../../src/services/billing-credit-funding-context.service.js';

export const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
export const occurredAt = new Date('2026-07-21T12:00:00.000Z');
export const fundingRaceIds = {
  user: 'usr_funding_race',
  org: 'org_funding_race',
  orgMember: 'om_funding_race',
  team: 'team_funding_race',
  teamMember: 'tm_funding_race',
  service: 'svc_funding_race',
  appKey: 'bak_funding_race',
  account: 'bsa_funding_race',
  customer: 'bsc_funding_race',
  policy: 'bcfp_funding_race',
  offer: 'bcto_funding_race',
  option: 'bcao_funding_race',
  catalog: 'bctc_funding_race',
  creditAccount: 'bca_funding_race',
  originalConsent: 'bcar_funding_race_original',
  setup: 'bcsc_funding_race',
  webhook: 'bswe_funding_race',
} as const;

const ids = fundingRaceIds;
export const stripeAccount = {
  id: ids.account,
  stripeAccountId: 'acct_funding_race',
  livemode: false,
};
export const credential = {
  id: ids.appKey,
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  checkoutReturnOrigins: ['https://funding-race.example'],
  service: { id: ids.service, identifier: 'funding-race', name: 'Funding Race' },
};
export const fundingRaceRequest = {
  product: 'funding-race',
  organisationId: ids.org,
  teamId: ids.team,
  userId: ids.user,
};
export const optionSelection = {
  policy: { id: ids.policy, automaticConsentVersion: 'auto-v1' },
  option: {
    id: ids.option,
    thresholdMicrocredits: 200_000_000n,
    monthlyChargeCapMinor: 1_500n,
  },
  offer: {
    id: ids.offer,
    paymentAmountMinor: 500n,
    creditsReceivedMicrocredits: 5_000_000_000n,
  },
  catalog: {
    id: ids.catalog,
    stripePriceId: 'price_funding_race',
    stripeProductId: 'prod_funding_race',
    stripeLookupKey: 'funding-race-v1',
    paymentAmountMinor: 500n,
  },
};

export async function seedFundingRace(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.user.create({
      data: {
        id: ids.user,
        email: 'funding-race@example.com',
        userKey: 'funding-race@example.com',
        name: 'Funding Race Owner',
      },
    });
    await tx.organisation.create({
      data: {
        id: ids.org,
        domain: 'funding-race.example.com',
        name: 'Funding Race Org',
        slug: 'funding-race-org',
        ownerId: ids.user,
      },
    });
    await tx.orgMember.create({
      data: {
        id: ids.orgMember,
        orgId: ids.org,
        userId: ids.user,
        role: 'owner',
        status: MembershipStatus.ACTIVE,
      },
    });
    await tx.team.create({
      data: { id: ids.team, orgId: ids.org, name: 'Funding Race Team', slug: 'funding-race' },
    });
    await tx.teamMember.create({
      data: {
        id: ids.teamMember,
        teamId: ids.team,
        userId: ids.user,
        teamRole: 'owner',
        status: MembershipStatus.ACTIVE,
      },
    });
    await tx.billingService.create({
      data: { id: ids.service, identifier: 'funding-race', name: 'Funding Race' },
    });
    await tx.billingAppKey.create({
      data: {
        id: ids.appKey,
        serviceId: ids.service,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Funding race lifecycle key',
        keyPrefix: 'uoa_race',
        secretDigest: 'b'.repeat(64),
        actorIssuer: 'https://funding-race.example',
        actorAudience: 'https://uoa.example',
        actorKeyId: 'funding-race-key',
        actorPublicJwk: { kty: 'RSA' },
        checkoutReturnOrigins: ['https://funding-race.example'],
      },
    });
    await tx.billingStripeAccount.create({
      data: {
        id: ids.account,
        stripeAccountId: stripeAccount.stripeAccountId,
        livemode: false,
      },
    });
    await tx.billingStripeCustomer.create({
      data: {
        id: ids.customer,
        accountId: ids.account,
        orgId: ids.org,
        teamId: ids.team,
        scope: BillingAssignmentScope.TEAM,
        scopeKey: `${ids.org}:${ids.team}`,
        stripeCustomerId: 'cus_funding_race',
      },
    });
    await tx.billingCreditFundingPolicy.create({
      data: {
        id: ids.policy,
        serviceId: ids.service,
        currency: 'USD',
        version: 1,
        topUpEnabled: true,
        automaticTopUpEnabled: true,
        automaticConsentVersion: 'auto-v1',
      },
    });
    await tx.billingCreditTopUpOffer.create({
      data: {
        id: ids.offer,
        policyId: ids.policy,
        serviceId: ids.service,
        key: 'five-dollar-refill',
        version: 1,
        catalogKey: 'funding-race',
        catalogVersion: 1,
        name: 'Five dollar refill',
        description: 'Five thousand credits',
        paymentAmountMinor: 500n,
        creditsReceivedMicrocredits: 5_000_000_000n,
        automaticTopUpEligible: true,
      },
    });
    await tx.billingCreditAutoTopUpOption.create({
      data: {
        id: ids.option,
        policyId: ids.policy,
        serviceId: ids.service,
        refillOfferId: ids.offer,
        key: 'low-balance-refill',
        version: 1,
        thresholdMicrocredits: 200_000_000n,
        monthlyChargeCapMinor: 1_500n,
      },
    });
    await tx.billingCreditTopUpCatalog.create({
      data: {
        id: ids.catalog,
        accountId: ids.account,
        key: 'funding-race',
        version: 1,
        currency: 'USD',
        paymentAmountMinor: 500n,
        creditsReceivedMicrocredits: 5_000_000_000n,
        stripeLookupKey: 'funding-race-v1',
        stripeProductId: 'prod_funding_race',
        stripePriceId: 'price_funding_race',
      },
    });
    await tx.billingCreditAccount.create({
      data: {
        id: ids.creditAccount,
        accountId: ids.account,
        customerId: ids.customer,
        orgId: ids.org,
        teamId: ids.team,
      },
    });
    const paymentMethodSummary = { type: 'card', brand: 'visa', last4: '4242' };
    await tx.billingCreditAutoTopUpConsentRevision.create({
      data: {
        id: ids.originalConsent,
        accountId: ids.account,
        creditAccountId: ids.creditAccount,
        orgId: ids.org,
        teamId: ids.team,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        policyId: ids.policy,
        optionId: ids.option,
        refillOfferId: ids.offer,
        source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
        actorJti: 'actor-original-consent',
        consentedByUserId: ids.user,
        consentVersion: 'auto-v1',
        thresholdMicrocredits: 200_000_000n,
        refillCreditsMicrocredits: 5_000_000_000n,
        refillPaymentAmountMinor: 500n,
        monthlyChargeCapMinor: 1_500n,
        stripePaymentMethodId: 'pm_funding_race',
        paymentMethodSummary,
        consentedAt: occurredAt,
      },
    });
    await tx.billingCreditAccount.update({
      where: { id: ids.creditAccount },
      data: {
        autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
        autoTopUpPolicyId: ids.policy,
        autoTopUpServiceId: ids.service,
        autoTopUpAppKeyId: ids.appKey,
        autoTopUpConsentRevisionId: ids.originalConsent,
        autoTopUpOptionId: ids.option,
        autoTopUpThresholdMicrocredits: 200_000_000n,
        autoTopUpRefillOfferId: ids.offer,
        autoTopUpMonthlyChargeCapMinor: 1_500n,
        autoTopUpConsentVersion: 'auto-v1',
        autoTopUpConsentedAt: occurredAt,
        autoTopUpConsentedByUserId: ids.user,
        stripePaymentMethodId: 'pm_funding_race',
        paymentMethodSummary,
      },
    });
    await tx.billingCreditSetupCheckout.create({
      data: {
        id: ids.setup,
        accountId: ids.account,
        creditAccountId: ids.creditAccount,
        customerId: ids.customer,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        policyId: ids.policy,
        optionId: ids.option,
        actorJti: 'actor-stale-setup',
        requestedByUserId: ids.user,
        expectedGeneration: 0,
        expectedConsentRevisionId: ids.originalConsent,
        consentVersion: 'auto-v1',
        thresholdMicrocredits: 200_000_000n,
        refillOfferId: ids.offer,
        refillCreditsMicrocredits: 5_000_000_000n,
        refillPaymentAmountMinor: 500n,
        monthlyChargeCapMinor: 1_500n,
        successUrlDigest: 'c'.repeat(64),
        cancelUrlDigest: 'd'.repeat(64),
        stripeCheckoutSessionId: 'cs_funding_race',
        status: BillingCreditCheckoutStatus.OPEN,
        leaseExpiresAt: new Date('2026-07-21T12:10:00.000Z'),
      },
    });
    await tx.billingStripeWebhookEvent.create({
      data: {
        id: ids.webhook,
        accountId: ids.account,
        stripeEventId: 'evt_funding_race_setup',
        type: 'setup_intent.succeeded',
        livemode: false,
        stripeCreatedAt: occurredAt,
        stripeObjectId: 'seti_funding_race',
        stripeCustomerId: 'cus_funding_race',
        stripeCheckoutSessionId: 'cs_funding_race',
        stripeSetupIntentId: 'seti_funding_race',
        stripePaymentMethodId: 'pm_stale_setup',
      },
    });
  });
}

export function fundingActionContext(creditAccount: BillingCreditAccount) {
  return {
    actor: { jti: 'actor-current-action' },
    viewer: { billingManager: true },
    account: stripeAccount,
    creditAccount,
    customer: { id: ids.customer, stripeCustomerId: 'cus_funding_race' },
    stripe: {
      paymentMethods: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'pm_funding_race',
          livemode: false,
          customer: 'cus_funding_race',
          type: 'card',
          card: { brand: 'visa', last4: '4242' },
        }),
      },
    },
  } as unknown as CreditFundingActionContext;
}
