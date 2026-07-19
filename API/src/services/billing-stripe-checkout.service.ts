import {
  BillingAssignmentScope,
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
  resolveEffectiveTariffContext,
  type EffectiveTariffPayload,
} from './billing-entitlement.service.js';
import {
  ensureStripeCatalog,
  ensureStripeTariffPrice,
} from './billing-stripe-catalog.service.js';
import { requireStripeBillingEnabled } from './billing-stripe-client.service.js';

type StripeCheckoutClient = Pick<
  Stripe,
  'billing' | 'checkout' | 'customers' | 'prices' | 'products'
>;

type CheckoutRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
  successUrl: string;
  cancelUrl: string;
};

const TERMINAL_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'] as const;
const BILLING_MANAGER_ROLES = new Set(['owner', 'admin']);

function digestUrl(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nextUtcMonthStart(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
}

function normalizeReturnUrl(value: string, allowedOrigins: string[]): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !allowedOrigins.includes(url.origin)
    ) {
      throw new Error('invalid');
    }
    return url.toString();
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_RETURN_URL_NOT_ALLOWED');
  }
}

function billingScope(
  payload: EffectiveTariffPayload,
): {
  scope: BillingAssignmentScope;
  scopeKey: string;
  teamId: string | null;
} {
  if (payload.assignment.scope === 'team') {
    return {
      scope: BillingAssignmentScope.TEAM,
      scopeKey: `${payload.subject.organisation_id}:${payload.subject.team_id}`,
      teamId: payload.subject.team_id,
    };
  }
  return {
    scope: BillingAssignmentScope.ORGANISATION,
    scopeKey: payload.subject.organisation_id,
    teamId: null,
  };
}

function isBillingManager(params: {
  scope: BillingAssignmentScope;
  orgRole: string;
  teamRole?: string | null;
}): boolean {
  if (BILLING_MANAGER_ROLES.has(params.orgRole)) return true;
  return (
    params.scope === BillingAssignmentScope.TEAM &&
    Boolean(params.teamRole && BILLING_MANAGER_ROLES.has(params.teamRole))
  );
}

function assertReplayBinding(
  checkout: {
    appKeyId: string;
    serviceId: string;
    tariffId: string;
    orgId: string;
    teamId: string | null;
    requestedByUserId: string;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
  expected: {
    credential: VerifiedBillingAppKey;
    payload: EffectiveTariffPayload;
    scopeTeamId: string | null;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
): void {
  if (
    checkout.appKeyId !== expected.credential.id ||
    checkout.serviceId !== expected.credential.service.id ||
    checkout.tariffId !== expected.payload.tariff.id ||
    checkout.orgId !== expected.payload.subject.organisation_id ||
    checkout.teamId !== expected.scopeTeamId ||
    checkout.requestedByUserId !== expected.payload.subject.user_id ||
    checkout.successUrlDigest !== expected.successUrlDigest ||
    checkout.cancelUrlDigest !== expected.cancelUrlDigest
  ) {
    throw new AppError('FORBIDDEN', 403, 'STRIPE_CHECKOUT_REPLAY_MISMATCH');
  }
}

async function existingCheckoutResult(
  checkout: {
    stripeCheckoutSessionId: string | null;
    status: string;
  },
  stripe: StripeCheckoutClient,
) {
  if (!checkout.stripeCheckoutSessionId) return null;
  const session = await stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
  if (session.status !== 'open' || !session.url) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_CHECKOUT_NOT_OPEN');
  }
  return {
    checkout_session_id: session.id,
    checkout_url: session.url,
    expires_at: new Date(session.expires_at * 1000).toISOString(),
  };
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
    resolveTariff?: typeof resolveEffectiveTariffContext;
    now?: () => Date;
  },
) {
  const successUrl = normalizeReturnUrl(
    params.request.successUrl,
    params.credential.checkoutReturnOrigins,
  );
  const cancelUrl = normalizeReturnUrl(
    params.request.cancelUrl,
    params.credential.checkoutReturnOrigins,
  );
  const successUrlDigest = digestUrl(successUrl);
  const cancelUrlDigest = digestUrl(cancelUrl);
  const prisma = deps?.prisma ?? getAdminPrisma();
  const stripe = deps?.stripe ?? requireStripeBillingEnabled().client;
  const { actor, payload } = await (
    deps?.resolveTariff ?? resolveEffectiveTariffContext
  )({
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
    const [user, org, team, orgMember, teamMember, tariff, activeSubscription, replay] =
      await Promise.all([
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
          where: {
            id: payload.tariff.id,
            serviceId: params.credential.service.id,
          },
        }),
        tx.billingStripeSubscription.findFirst({
          where: {
            serviceId: params.credential.service.id,
            scope: selectedScope.scope,
            scopeKey: selectedScope.scopeKey,
            status: { notIn: [...TERMINAL_SUBSCRIPTION_STATUSES] },
          },
          select: { id: true },
        }),
        tx.billingStripeCheckoutSession.findUnique({
          where: {
            appKeyId_actorJti: {
              appKeyId: params.credential.id,
              actorJti: actor.jti,
            },
          },
        }),
      ]);
    return { user, org, team, orgMember, teamMember, tariff, activeSubscription, replay };
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

  if (details.replay) {
    assertReplayBinding(details.replay, {
      credential: params.credential,
      payload,
      scopeTeamId: selectedScope.teamId,
      successUrlDigest,
      cancelUrlDigest,
    });
    const existing = await existingCheckoutResult(details.replay, stripe);
    if (existing) return { ...existing, tariff: payload.tariff };
  }

  let customer = await prisma.billingStripeCustomer.upsert({
    where: { scopeKey: selectedScope.scopeKey },
    create: {
      orgId: payload.subject.organisation_id,
      teamId: selectedScope.teamId,
      scope: selectedScope.scope,
      scopeKey: selectedScope.scopeKey,
    },
    update: {},
  });
  if (!customer.stripeCustomerId) {
    const stripeCustomer = await stripe.customers.create(
      {
        email: details.user.email,
        name: details.team?.name ?? details.org.name,
        metadata: {
          uoa_scope: selectedScope.scope.toLowerCase(),
          uoa_scope_key: selectedScope.scopeKey,
          uoa_organisation_id: payload.subject.organisation_id,
          ...(selectedScope.teamId ? { uoa_team_id: selectedScope.teamId } : {}),
        },
      },
      { idempotencyKey: `uoa:customer:${customer.id}` },
    );
    customer = await prisma.billingStripeCustomer.update({
      where: { id: customer.id },
      data: { stripeCustomerId: stripeCustomer.id },
    });
  }

  let checkout = details.replay;
  if (!checkout) {
    try {
      checkout = await prisma.billingStripeCheckoutSession.create({
        data: {
          appKeyId: params.credential.id,
          customerId: customer.id,
          serviceId: params.credential.service.id,
          tariffId: details.tariff.id,
          orgId: payload.subject.organisation_id,
          teamId: selectedScope.teamId,
          scope: selectedScope.scope,
          scopeKey: selectedScope.scopeKey,
          actorJti: actor.jti,
          requestedByUserId: payload.subject.user_id,
          successUrlDigest,
          cancelUrlDigest,
        },
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw new AppError('BAD_REQUEST', 409, 'STRIPE_CHECKOUT_ALREADY_OPEN');
      }
      throw error;
    }
  }

  const catalog = await ensureStripeCatalog(
    {
      service: params.credential.service,
      currency: details.tariff.currency,
      stripe,
    },
    { prisma },
  );
  const tariffPrice = await ensureStripeTariffPrice(
    {
      tariff: details.tariff,
      catalog,
      stripe,
    },
    { prisma },
  );
  if (!catalog.stripeUsagePriceId) {
    throw new AppError('INTERNAL', 500, 'STRIPE_CATALOG_INCOMPLETE');
  }
  if (!customer.stripeCustomerId) {
    throw new AppError('INTERNAL', 500, 'STRIPE_CUSTOMER_INCOMPLETE');
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
        billing_cycle_anchor: nextUtcMonthStart(deps?.now?.() ?? new Date()),
        proration_behavior: 'none',
        metadata: {
          uoa_checkout_id: checkout.id,
          uoa_service_id: params.credential.service.id,
          uoa_tariff_id: details.tariff.id,
          uoa_scope_key: selectedScope.scopeKey,
        },
      },
    },
    { idempotencyKey: `uoa:checkout:${checkout.id}` },
  );
  if (!session.url) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_URL_MISSING');
  }

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
        },
      },
    }),
  ]);

  return {
    checkout_session_id: session.id,
    checkout_url: session.url,
    expires_at: new Date(session.expires_at * 1000).toISOString(),
    tariff: payload.tariff,
  };
}
