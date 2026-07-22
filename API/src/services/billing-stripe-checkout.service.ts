import {
  BillingCollectionMode,
  BillingTariffMode,
  MembershipStatus,
  type PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
} from './billing-customer-action-intent.service.js';
import {
  resolveEffectiveTariffContext,
  type EffectiveTariffPayload,
} from './billing-entitlement.service.js';
import { ensureStripeCatalog, ensureStripeTariffPrice } from './billing-stripe-catalog.service.js';
import {
  checkoutIdempotencyKey,
  reconcileStripeCheckoutLease,
} from './billing-stripe-checkout-recovery.service.js';
import {
  assertCheckoutBinding,
  billingScope,
  ensureStripeCustomer,
  overlappingCheckoutScope,
  overlappingSubscriptionScope,
  tariffSource,
  type StripeCheckoutClient,
} from './billing-stripe-checkout-state.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';
import { normalizeStripeReturnUrl } from './billing-stripe-return-url.service.js';

type CheckoutRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
  successUrl: string;
  cancelUrl: string;
};

const CHECKOUT_LEASE_MS = 10 * 60 * 1000;

function digestUrl(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nextUtcMonthStart(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
}

function externalId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function openSessionResult(session: Stripe.Checkout.Session, payload: EffectiveTariffPayload) {
  if (session.status !== 'open' || !session.url) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_CHECKOUT_NOT_OPEN');
  }
  return {
    checkout_session_id: session.id,
    checkout_url: session.url,
    expires_at: new Date(session.expires_at * 1000).toISOString(),
    tariff: payload.tariff,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

export async function createStripeCheckoutSession(
  params: {
    request: CheckoutRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeCheckoutClient;
    stripeLivemode?: boolean;
    resolveTariff?: typeof resolveEffectiveTariffContext;
    authorizeAction?: typeof authorizeBillingCustomerAction;
    now?: () => Date;
    afterStripeSessionCreated?: () => void | Promise<void>;
  },
) {
  const successUrl = normalizeStripeReturnUrl(
    params.request.successUrl,
    params.credential.checkoutReturnOrigins,
  );
  const cancelUrl = normalizeStripeReturnUrl(
    params.request.cancelUrl,
    params.credential.checkoutReturnOrigins,
  );
  const successUrlDigest = digestUrl(successUrl);
  const cancelUrlDigest = digestUrl(cancelUrl);
  const prisma = deps?.prisma ?? getAdminPrisma();
  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  const livemode = deps?.stripeLivemode ?? configured?.livemode ?? false;
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  const { actor, payload } = await (deps?.resolveTariff ?? resolveEffectiveTariffContext)({
    request: params.request,
    actorToken: params.actorToken,
    credential: params.credential,
  });
  if (
    payload.tariff.collection_mode !== 'stripe' ||
    payload.tariff.mode === 'free' ||
    !payload.tariff.payment_collection_enabled
  ) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_COLLECTION_NOT_ENABLED');
  }

  const selectedScope = billingScope(payload);
  const details = await prisma.$transaction(async (tx) => {
    const [user, org, team, orgMember, teamMember, tariff, activeSubscription] = await Promise.all([
      tx.user.findUnique({
        where: { id: payload.subject.user_id },
        select: { id: true, email: true, name: true },
      }),
      tx.organisation.findUnique({
        where: { id: payload.subject.organisation_id },
        select: { id: true, name: true },
      }),
      selectedScope.teamId
        ? tx.team.findUnique({
            where: { id: selectedScope.teamId },
            select: { id: true, name: true, orgId: true },
          })
        : null,
      tx.orgMember.findUnique({
        where: {
          orgId_userId: {
            orgId: payload.subject.organisation_id,
            userId: payload.subject.user_id,
          },
        },
        select: { role: true, status: true },
      }),
      selectedScope.teamId
        ? tx.teamMember.findUnique({
            where: {
              teamId_userId: {
                teamId: selectedScope.teamId,
                userId: payload.subject.user_id,
              },
            },
            select: { teamRole: true, status: true },
          })
        : null,
      tx.billingTariff.findFirst({
        where: { id: payload.tariff.id, serviceId: params.credential.service.id },
      }),
      tx.billingStripeSubscription.findFirst({
        where: overlappingSubscriptionScope(
          account.id,
          params.credential.service.id,
          payload.subject.organisation_id,
          selectedScope.scope,
          selectedScope.scopeKey,
        ),
        select: { id: true },
      }),
    ]);
    return { user, org, team, orgMember, teamMember, tariff, activeSubscription };
  });
  if (
    !details.user ||
    !details.org ||
    details.orgMember?.status !== MembershipStatus.ACTIVE ||
    (selectedScope.teamId &&
      (!details.team ||
        details.team.orgId !== details.org.id ||
        details.teamMember?.status !== MembershipStatus.ACTIVE)) ||
    !isBillingManager({
      scope: selectedScope.scope,
      orgRole: details.orgMember.role,
      teamRole: details.teamMember?.teamRole,
    })
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_MANAGER_REQUIRED');
  }
  if (details.activeSubscription) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_SUBSCRIPTION_EXISTS');
  }
  if (
    !details.tariff ||
    details.tariff.collectionMode !== BillingCollectionMode.STRIPE ||
    details.tariff.mode === BillingTariffMode.FREE ||
    details.tariff.currency !== payload.tariff.monthly_subscription.currency ||
    details.tariff.monthlyAmountMinor.toString() !==
      payload.tariff.monthly_subscription.amount_minor
  ) {
    throw new AppError('INTERNAL', 500, 'STRIPE_TARIFF_MISMATCH');
  }
  await (deps?.authorizeAction ?? authorizeBillingCustomerAction)(
    {
      credential: params.credential,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
      userId: params.request.userId,
      authorityScope: selectedScope.scope,
      operation: BILLING_CUSTOMER_ACTION.STRIPE_CHECKOUT,
      actor,
      request: {
        product: params.request.product,
        organisation_id: params.request.organisationId,
        team_id: params.request.teamId,
        user_id: params.request.userId,
        tariff_id: details.tariff.id,
        scope: selectedScope.scope,
        scope_key: selectedScope.scopeKey,
        success_url_digest: successUrlDigest,
        cancel_url_digest: cancelUrlDigest,
      },
    },
    { prisma },
  );

  let customer = await prisma.billingStripeCustomer.upsert({
    where: {
      accountId_scopeKey: { accountId: account.id, scopeKey: selectedScope.scopeKey },
    },
    create: {
      accountId: account.id,
      orgId: payload.subject.organisation_id,
      teamId: selectedScope.teamId,
      scope: selectedScope.scope,
      scopeKey: selectedScope.scopeKey,
    },
    update: {},
  });
  if (
    customer.accountId !== account.id ||
    customer.orgId !== payload.subject.organisation_id ||
    customer.teamId !== selectedScope.teamId ||
    customer.scope !== selectedScope.scope
  ) {
    throw new AppError('INTERNAL', 500, 'STRIPE_CUSTOMER_SCOPE_INVALID');
  }
  customer = await ensureStripeCustomer(
    {
      customer,
      account,
      email: details.user.email,
      name: details.team?.name ?? details.org.name,
      orgId: payload.subject.organisation_id,
      teamId: selectedScope.teamId,
      scope: selectedScope.scope,
      scopeKey: selectedScope.scopeKey,
    },
    { prisma, stripe },
  );
  if (!customer.stripeCustomerId) {
    throw new AppError('INTERNAL', 500, 'STRIPE_CUSTOMER_INCOMPLETE');
  }

  const now = deps?.now?.() ?? new Date();
  let checkout = await prisma.billingStripeCheckoutSession.findFirst({
    where: overlappingCheckoutScope(
      account.id,
      params.credential.service.id,
      payload.subject.organisation_id,
      selectedScope.scope,
      selectedScope.scopeKey,
    ),
  });
  if (checkout) {
    assertCheckoutBinding(checkout, {
      account,
      credential: params.credential,
      customerId: customer.id,
      payload,
      scope: selectedScope,
      successUrlDigest,
      cancelUrlDigest,
    });
    const recovered = await reconcileStripeCheckoutLease(
      { checkout, customerStripeId: customer.stripeCustomerId, account, now },
      { prisma, stripe },
    );
    if (recovered.session) return openSessionResult(recovered.session, payload);
    checkout = recovered.abandoned ? null : recovered.checkout;
  }

  if (!checkout) {
    const createData = {
      accountId: account.id,
      appKeyId: params.credential.id,
      customerId: customer.id,
      serviceId: params.credential.service.id,
      tariffId: details.tariff.id,
      tariffSource: tariffSource(payload),
      tariffAssignmentId: payload.assignment.id,
      orgId: payload.subject.organisation_id,
      teamId: selectedScope.teamId,
      scope: selectedScope.scope,
      scopeKey: selectedScope.scopeKey,
      actorJti: actor.jti,
      requestedByUserId: payload.subject.user_id,
      successUrlDigest,
      cancelUrlDigest,
      leaseExpiresAt: new Date(now.getTime() + CHECKOUT_LEASE_MS),
    };
    for (let attempt = 0; !checkout && attempt < 3; attempt += 1) {
      try {
        checkout = await prisma.billingStripeCheckoutSession.create({
          data: createData,
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        checkout = await prisma.billingStripeCheckoutSession.findFirst({
          where: overlappingCheckoutScope(
            account.id,
            params.credential.service.id,
            payload.subject.organisation_id,
            selectedScope.scope,
            selectedScope.scopeKey,
          ),
        });
        if (!checkout) continue;
        assertCheckoutBinding(checkout, {
          account,
          credential: params.credential,
          customerId: customer.id,
          payload,
          scope: selectedScope,
          successUrlDigest,
          cancelUrlDigest,
        });
        const recovered = await reconcileStripeCheckoutLease(
          { checkout, customerStripeId: customer.stripeCustomerId, account, now },
          { prisma, stripe },
        );
        if (recovered.session) return openSessionResult(recovered.session, payload);
        checkout = recovered.abandoned ? null : recovered.checkout;
      }
    }
    if (!checkout) {
      throw new AppError('INTERNAL', 503, 'STRIPE_CHECKOUT_RETRY');
    }
  }

  const catalog = await ensureStripeCatalog(
    {
      service: params.credential.service,
      currency: details.tariff.currency,
      account,
      stripe,
    },
    { prisma },
  );
  const tariffPrice = await ensureStripeTariffPrice(
    { tariff: details.tariff, catalog, account, stripe },
    { prisma },
  );
  if (!catalog.stripeUsagePriceId) {
    throw new AppError('INTERNAL', 500, 'STRIPE_CATALOG_INCOMPLETE');
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customer.stripeCustomerId,
      client_reference_id: checkout.id,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: false,
      billing_address_collection: 'required',
      payment_method_collection: 'always',
      line_items: [
        ...(tariffPrice.stripeMonthlyPriceId
          ? [{ price: tariffPrice.stripeMonthlyPriceId, quantity: 1 }]
          : []),
        { price: catalog.stripeUsagePriceId },
      ],
      metadata: { uoa_checkout_id: checkout.id },
      subscription_data: {
        billing_cycle_anchor: nextUtcMonthStart(now),
        proration_behavior: 'none',
        metadata: {
          uoa_checkout_id: checkout.id,
          uoa_service_id: params.credential.service.id,
          uoa_tariff_id: details.tariff.id,
          uoa_scope_key: selectedScope.scopeKey,
          uoa_stripe_account_id: account.stripeAccountId,
          uoa_stripe_mode: account.livemode ? 'live' : 'test',
        },
      },
    },
    { idempotencyKey: checkoutIdempotencyKey(account, checkout.id) },
  );
  assertStripeObjectLivemode(session, account.livemode);
  if (
    session.client_reference_id !== checkout.id ||
    session.metadata?.uoa_checkout_id !== checkout.id ||
    externalId(session.customer) !== customer.stripeCustomerId ||
    session.mode !== 'subscription' ||
    !session.url
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_BINDING_INVALID');
  }
  await deps?.afterStripeSessionCreated?.();

  await prisma.$transaction([
    prisma.billingStripeCheckoutSession.update({
      where: { id: checkout.id },
      data: {
        stripeCheckoutSessionId: session.id,
        status: session.status ?? 'open',
        expiresAt: new Date(session.expires_at * 1000),
      },
    }),
    prisma.orgAuditLog.create({
      data: {
        orgId: payload.subject.organisation_id,
        actorUserId: payload.subject.user_id,
        action: 'billing.stripe_checkout_created',
        targetType: 'billing_stripe_checkout',
        targetId: checkout.id,
        metadata: {
          product: params.credential.service.identifier,
          service_id: params.credential.service.id,
          tariff_id: details.tariff.id,
          scope: selectedScope.scope.toLowerCase(),
          scope_key: selectedScope.scopeKey,
          app_key_id: params.credential.id,
          stripe_account_id: account.stripeAccountId,
          livemode: account.livemode,
        },
      },
    }),
  ]);
  return openSessionResult(session, payload);
}
