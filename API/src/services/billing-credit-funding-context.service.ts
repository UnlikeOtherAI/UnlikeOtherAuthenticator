import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { ensureTeamCreditAccount } from './billing-credit-account.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import {
  resolveBillingFundingViewer,
  type BillingFundingViewer,
} from './billing-funding-viewer.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { ensureStripeCustomer } from './billing-stripe-checkout-state.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import {
  CREDIT_PRODUCT_METADATA,
  creditPriceMetadata,
} from './billing-stripe-catalog-provisioning-spec.js';

export type CreditFundingActionRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

export type CreditFundingStripeClient = Pick<
  Stripe,
  'accounts' | 'checkout' | 'customers' | 'paymentIntents' | 'paymentMethods' | 'prices'
>;

export type CreditFundingActionContext = {
  actor: { jti: string };
  viewer: BillingFundingViewer;
  account: StripeAccountContext;
  creditAccount: Awaited<ReturnType<typeof ensureTeamCreditAccount>>;
  customer: Awaited<ReturnType<typeof ensureStripeCustomer>>;
  stripe: CreditFundingStripeClient;
};

type ContextDependencies = {
  prisma?: PrismaClient;
  stripe?: CreditFundingStripeClient;
  stripeLivemode?: boolean;
  resolveTariff?: typeof resolveEffectiveTariffContext;
  resolveViewer?: typeof resolveBillingFundingViewer;
  resolveAccount?: typeof resolveStripeAccountContext;
  ensureCreditAccount?: typeof ensureTeamCreditAccount;
  ensureCustomer?: typeof ensureStripeCustomer;
};

export async function resolveCreditFundingActionContext(
  params: {
    request: CreditFundingActionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: ContextDependencies,
): Promise<CreditFundingActionContext> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [{ actor }, viewer] = await Promise.all([
    (deps?.resolveTariff ?? resolveEffectiveTariffContext)(params, { prisma }),
    (deps?.resolveViewer ?? resolveBillingFundingViewer)(
      {
        userId: params.request.userId,
        organisationId: params.request.organisationId,
        teamId: params.request.teamId,
      },
      { prisma },
    ),
  ]);
  if (!viewer.billingManager) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_MANAGER_REQUIRED');
  }

  const configured = deps?.stripe ? null : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const livemode = deps?.stripeLivemode ?? configured?.livemode ?? false;
  const account = await (deps?.resolveAccount ?? resolveStripeAccountContext)(
    stripe,
    livemode,
    prisma,
  );
  const creditAccount = await (deps?.ensureCreditAccount ?? ensureTeamCreditAccount)(
    {
      account,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const [localCustomer, user, organisation, team] = await Promise.all([
    prisma.billingStripeCustomer.findUnique({ where: { id: creditAccount.customerId } }),
    prisma.user.findUnique({
      where: { id: params.request.userId },
      select: { id: true, email: true },
    }),
    prisma.organisation.findUnique({
      where: { id: params.request.organisationId },
      select: { id: true, name: true },
    }),
    prisma.team.findFirst({
      where: { id: params.request.teamId, orgId: params.request.organisationId },
      select: { id: true, name: true },
    }),
  ]);
  if (!localCustomer || !user || !organisation || !team) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }
  const customer = await (deps?.ensureCustomer ?? ensureStripeCustomer)(
    {
      customer: localCustomer,
      account,
      email: user.email,
      name: team.name || organisation.name,
      orgId: organisation.id,
      teamId: team.id,
      scope: localCustomer.scope,
      scopeKey: localCustomer.scopeKey,
    },
    { prisma, stripe },
  );
  if (!customer.stripeCustomerId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CUSTOMER_INCOMPLETE');
  }
  return { actor, viewer, account, creditAccount, customer, stripe };
}

export async function resolveCreditTopUpOffer(
  params: { serviceId: string; accountId: string; offerId: string },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const offer = await prisma.billingCreditTopUpOffer.findFirst({
    where: {
      id: params.offerId,
      serviceId: params.serviceId,
      active: true,
      policy: { serviceId: params.serviceId, currency: 'USD', active: true, topUpEnabled: true },
    },
    include: { policy: true },
  });
  if (!offer) throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_OFFER_UNAVAILABLE');
  const catalog = await prisma.billingCreditTopUpCatalog.findUnique({
    where: {
      accountId_key_version: {
        accountId: params.accountId,
        key: offer.catalogKey,
        version: offer.catalogVersion,
      },
    },
  });
  assertCatalogBinding(catalog, offer);
  return { policy: offer.policy, offer, catalog: catalog as NonNullable<typeof catalog> };
}

export async function resolveCreditAutoTopUpOption(
  params: { serviceId: string; accountId: string; optionId: string },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const option = await prisma.billingCreditAutoTopUpOption.findFirst({
    where: {
      id: params.optionId,
      serviceId: params.serviceId,
      active: true,
      policy: {
        serviceId: params.serviceId,
        currency: 'USD',
        active: true,
        automaticTopUpEnabled: true,
      },
    },
    include: { policy: true, refillOffer: true },
  });
  if (!option || !option.refillOffer.active || !option.refillOffer.automaticTopUpEligible) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_OPTION_UNAVAILABLE');
  }
  const catalog = await prisma.billingCreditTopUpCatalog.findUnique({
    where: {
      accountId_key_version: {
        accountId: params.accountId,
        key: option.refillOffer.catalogKey,
        version: option.refillOffer.catalogVersion,
      },
    },
  });
  assertCatalogBinding(catalog, option.refillOffer);
  if (option.monthlyChargeCapMinor < option.refillOffer.paymentAmountMinor) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_AUTO_TOP_UP_TERMS_INVALID');
  }
  return {
    policy: option.policy,
    option,
    offer: option.refillOffer,
    catalog: catalog as NonNullable<typeof catalog>,
  };
}

function assertCatalogBinding(
  catalog: {
    accountId: string;
    currency: string;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
    stripeLookupKey: string;
    stripeProductId: string | null;
    stripePriceId: string | null;
  } | null,
  offer: {
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
  },
): void {
  if (
    !catalog ||
    catalog.currency !== 'USD' ||
    catalog.paymentAmountMinor !== offer.paymentAmountMinor ||
    catalog.creditsReceivedMicrocredits !== offer.creditsReceivedMicrocredits ||
    !catalog.stripeProductId ||
    !catalog.stripePriceId
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CATALOG_UNAVAILABLE');
  }
}

export async function assertCreditCatalogPrice(
  stripe: Pick<Stripe, 'prices'>,
  account: StripeAccountContext,
  catalog: {
    stripeLookupKey: string;
    stripeProductId: string | null;
    stripePriceId: string | null;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
  },
): Promise<void> {
  if (!catalog.stripePriceId || !catalog.stripeProductId) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CATALOG_UNAVAILABLE');
  }
  const price = await stripe.prices.retrieve(catalog.stripePriceId, { expand: ['product'] });
  assertStripeObjectLivemode(price, account.livemode);
  const productId = stripeExternalId(price.product);
  const product = typeof price.product === 'string' ? null : price.product;
  const credits = catalog.creditsReceivedMicrocredits / 1_000_000n;
  const exactMetadata = (actual: Stripe.Metadata, expected: Record<string, string>): boolean => {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
    );
  };
  if (
    price.id !== catalog.stripePriceId ||
    !price.active ||
    price.type !== 'one_time' ||
    price.currency.toUpperCase() !== 'USD' ||
    price.unit_amount === null ||
    BigInt(price.unit_amount) !== catalog.paymentAmountMinor ||
    price.lookup_key !== catalog.stripeLookupKey ||
    productId !== catalog.stripeProductId ||
    !product ||
    'deleted' in product ||
    !product.active ||
    catalog.creditsReceivedMicrocredits % 1_000_000n !== 0n ||
    !exactMetadata(price.metadata, creditPriceMetadata({ credits })) ||
    !exactMetadata(product.metadata, CREDIT_PRODUCT_METADATA)
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CATALOG_BINDING_INVALID');
  }
  assertStripeObjectLivemode(product, account.livemode);
}
