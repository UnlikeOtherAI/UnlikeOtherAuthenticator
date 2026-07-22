import {
  BillingRecurringAddonCheckoutStatus,
  MembershipStatus,
  type BillingRecurringAddonCheckout,
  type PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import type { BillingHostedRedirectResponse } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
} from './billing-customer-action-intent.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import { ensureRecurringAddonStripeCatalog } from './billing-recurring-addon-catalog.service.js';
import {
  assertCanManageRecurringAddonScope,
  recurringAddonScope,
  recurringAddonSubjectFingerprint,
  uniqueEntitlementScope,
  type RecurringAddonSubject,
} from './billing-recurring-addon-scope.service.js';
import {
  assertRecurringAddonMetadata,
  recurringAddonMetadata,
} from './billing-recurring-addon-stripe-binding.service.js';
import {
  ensureStripeCustomer,
  type StripeCheckoutClient,
} from './billing-stripe-checkout-state.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

const CHECKOUT_LEASE_MS = 10 * 60 * 1000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function returnUrls(credential: VerifiedBillingAppKey): { success: string; cancel: string } {
  const origin = [...credential.checkoutReturnOrigins].sort()[0];
  if (!origin) {
    throw new AppError('INTERNAL', 503, 'BILLING_CHECKOUT_RETURN_ORIGIN_MISSING');
  }
  const success = new URL('/', origin);
  success.searchParams.set('uoa_billing', 'recurring_addon_success');
  const cancel = new URL('/', origin);
  cancel.searchParams.set('uoa_billing', 'recurring_addon_cancel');
  return { success: success.toString(), cancel: cancel.toString() };
}

function checkoutIdempotencyKey(checkout: BillingRecurringAddonCheckout): string {
  return `uoa:recurring-addon-checkout:${checkout.accountId}:${checkout.id}`;
}

function assertCheckoutIdentity(
  checkout: BillingRecurringAddonCheckout,
  expected: {
    accountId: string;
    appKeyId: string;
    customerId: string;
    catalogId: string;
    offerId: string;
    subjectFingerprint: string;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
): void {
  if (
    checkout.accountId !== expected.accountId ||
    checkout.appKeyId !== expected.appKeyId ||
    checkout.customerId !== expected.customerId ||
    checkout.catalogId !== expected.catalogId ||
    checkout.offerId !== expected.offerId ||
    checkout.subjectFingerprint !== expected.subjectFingerprint ||
    checkout.successUrlDigest !== expected.successUrlDigest ||
    checkout.cancelUrlDigest !== expected.cancelUrlDigest
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CHECKOUT_CONFLICT');
  }
}

function redirect(session: Stripe.Checkout.Session): BillingHostedRedirectResponse {
  if (session.status !== 'open' || !session.url || !session.url.startsWith('https://')) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CHECKOUT_NOT_OPEN');
  }
  return { redirect_url: session.url };
}

async function recoverOpenCheckout(
  checkout: BillingRecurringAddonCheckout,
  expectedCustomerId: string,
  deps: { prisma: PrismaClient; stripe: StripeCheckoutClient; livemode: boolean },
): Promise<{ redirect: BillingHostedRedirectResponse | null; reusable: boolean }> {
  if (!checkout.stripeCheckoutSessionId) return { redirect: null, reusable: true };
  const session = await deps.stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
  assertStripeObjectLivemode(session, deps.livemode);
  if (
    session.id !== checkout.stripeCheckoutSessionId ||
    session.client_reference_id !== checkout.id ||
    stripeExternalId(session.customer) !== expectedCustomerId ||
    session.mode !== 'subscription'
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CHECKOUT_DRIFT');
  }
  if (session.status === 'open') return { redirect: redirect(session), reusable: false };
  if (session.status === 'complete') {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_WEBHOOK_PENDING');
  }
  await deps.prisma.billingRecurringAddonCheckout.update({
    where: { id: checkout.id },
    data: {
      status: BillingRecurringAddonCheckoutStatus.EXPIRED,
      leaseExpiresAt: new Date(),
      expiresAt: new Date(session.expires_at * 1000),
    },
  });
  return { redirect: null, reusable: false };
}

export async function createRecurringAddonCheckout(
  params: {
    request: RecurringAddonSubject & { offerId: string };
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeCheckoutClient;
    stripeLivemode?: boolean;
    now?: () => Date;
    authorizeAction?: typeof authorizeBillingCustomerAction;
  },
): Promise<BillingHostedRedirectResponse> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { actor } = await resolveEffectiveTariffContext(
    { request: params.request, actorToken: params.actorToken, credential: params.credential },
    { prisma },
  );
  const viewer = await resolveBillingFundingViewer(params.request, { prisma });
  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const livemode = deps?.stripeLivemode ?? configured?.livemode ?? false;
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  const offer = await prisma.billingRecurringAddonOffer.findFirst({
    where: { id: params.request.offerId, serviceId: params.credential.service.id, active: true },
    include: {
      featurePolicies: { where: { active: true } },
      catalogs: { where: { accountId: account.id } },
    },
  });
  const entitlementScope = offer ? uniqueEntitlementScope(offer.featurePolicies) : null;
  if (!offer || !entitlementScope) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_UNAVAILABLE');
  }
  const selectedScope = recurringAddonScope(entitlementScope, params.request);
  assertCanManageRecurringAddonScope(viewer, selectedScope.scope);
  const urls = returnUrls(params.credential);
  let catalog = offer.catalogs[0];
  if (!catalog) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CATALOG_UNAVAILABLE');
  }
  const existingSubscription = await prisma.billingRecurringAddonSubscription.findFirst({
    where: {
      accountId: account.id,
      serviceId: offer.serviceId,
      offerKey: offer.key,
      scope: selectedScope.scope,
      scopeKey: selectedScope.scopeKey,
      status: { notIn: ['canceled', 'incomplete_expired'] },
    },
    select: { id: true },
  });
  if (existingSubscription) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_SUBSCRIPTION_EXISTS');
  }
  await (deps?.authorizeAction ?? authorizeBillingCustomerAction)(
    {
      credential: params.credential,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
      userId: params.request.userId,
      authorityScope: selectedScope.customerScope,
      operation: BILLING_CUSTOMER_ACTION.RECURRING_ADDON_CHECKOUT,
      actor,
      request: {
        product: params.request.product,
        organisation_id: params.request.organisationId,
        team_id: params.request.teamId,
        user_id: params.request.userId,
        offer_id: offer.id,
        scope: selectedScope.scope,
        scope_key: selectedScope.scopeKey,
        success_url_digest: digest(urls.success),
        cancel_url_digest: digest(urls.cancel),
      },
    },
    { prisma },
  );
  catalog = await ensureRecurringAddonStripeCatalog(
    {
      catalog,
      offer,
      serviceIdentifier: params.credential.service.identifier,
      serviceName: params.credential.service.name,
      account,
      stripe,
    },
    { prisma },
  );
  if (!catalog.stripePriceId) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CATALOG_INCOMPLETE');
  }

  const details = await prisma.$transaction(async (tx) => {
    const [user, organisation, team, orgMember, teamMember, liveSubscription] = await Promise.all([
      tx.user.findUnique({
        where: { id: params.request.userId },
        select: { id: true, email: true, name: true },
      }),
      tx.organisation.findUnique({
        where: { id: params.request.organisationId },
        select: { id: true, name: true },
      }),
      tx.team.findFirst({
        where: { id: params.request.teamId, orgId: params.request.organisationId },
        select: { id: true, name: true },
      }),
      tx.orgMember.findUnique({
        where: {
          orgId_userId: {
            orgId: params.request.organisationId,
            userId: params.request.userId,
          },
        },
        select: { status: true },
      }),
      tx.teamMember.findUnique({
        where: {
          teamId_userId: { teamId: params.request.teamId, userId: params.request.userId },
        },
        select: { status: true },
      }),
      tx.billingRecurringAddonSubscription.findFirst({
        where: {
          accountId: account.id,
          serviceId: offer.serviceId,
          offerKey: offer.key,
          scope: selectedScope.scope,
          scopeKey: selectedScope.scopeKey,
          status: { notIn: ['canceled', 'incomplete_expired'] },
        },
        select: { id: true },
      }),
    ]);
    return { user, organisation, team, orgMember, teamMember, liveSubscription };
  });
  if (
    !details.user ||
    !details.organisation ||
    !details.team ||
    details.orgMember?.status !== MembershipStatus.ACTIVE ||
    details.teamMember?.status !== MembershipStatus.ACTIVE
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }
  if (details.liveSubscription) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_SUBSCRIPTION_EXISTS');
  }

  let customer = await prisma.billingStripeCustomer.upsert({
    where: {
      accountId_scopeKey: { accountId: account.id, scopeKey: selectedScope.customerScopeKey },
    },
    create: {
      accountId: account.id,
      orgId: params.request.organisationId,
      teamId: selectedScope.customerTeamId,
      scope: selectedScope.customerScope,
      scopeKey: selectedScope.customerScopeKey,
    },
    update: {},
  });
  if (
    customer.orgId !== params.request.organisationId ||
    customer.teamId !== selectedScope.customerTeamId ||
    customer.scope !== selectedScope.customerScope
  ) {
    throw new AppError('INTERNAL', 409, 'BILLING_RECURRING_ADDON_CUSTOMER_DRIFT');
  }
  customer = await ensureStripeCustomer(
    {
      customer,
      account,
      email: details.user.email,
      name: selectedScope.customerTeamId ? details.team.name : details.organisation.name,
      orgId: params.request.organisationId,
      teamId: selectedScope.customerTeamId,
      scope: selectedScope.customerScope,
      scopeKey: selectedScope.customerScopeKey,
    },
    { prisma, stripe },
  );
  if (!customer.stripeCustomerId) {
    throw new AppError('INTERNAL', 503, 'STRIPE_CUSTOMER_INCOMPLETE');
  }

  const identity = {
    accountId: account.id,
    appKeyId: params.credential.id,
    customerId: customer.id,
    catalogId: catalog.id,
    offerId: offer.id,
    subjectFingerprint: recurringAddonSubjectFingerprint({
      appKeyId: params.credential.id,
      serviceId: offer.serviceId,
      offerId: offer.id,
      subject: params.request,
      scope: selectedScope,
    }),
    successUrlDigest: digest(urls.success),
    cancelUrlDigest: digest(urls.cancel),
  };
  let checkout = await prisma.billingRecurringAddonCheckout.findFirst({
    where: {
      accountId: account.id,
      serviceId: offer.serviceId,
      offerKey: offer.key,
      scope: selectedScope.scope,
      scopeKey: selectedScope.scopeKey,
      status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
    },
  });
  if (checkout) {
    assertCheckoutIdentity(checkout, identity);
    const recovered = await recoverOpenCheckout(checkout, customer.stripeCustomerId, {
      prisma,
      stripe,
      livemode,
    });
    if (recovered.redirect) return recovered.redirect;
    if (!recovered.reusable) checkout = null;
  }

  const now = deps?.now?.() ?? new Date();
  if (!checkout) {
    try {
      checkout = await prisma.billingRecurringAddonCheckout.create({
        data: {
          ...identity,
          serviceId: offer.serviceId,
          offerKey: offer.key,
          orgId: params.request.organisationId,
          teamId: selectedScope.teamId,
          requestedTeamId: params.request.teamId,
          subscribingUserId: selectedScope.subscribingUserId,
          scope: selectedScope.scope,
          scopeKey: selectedScope.scopeKey,
          actorJti: actor.jti,
          requestedByUserId: params.request.userId,
          leaseExpiresAt: new Date(now.getTime() + CHECKOUT_LEASE_MS),
        },
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error;
      checkout = await prisma.billingRecurringAddonCheckout.findFirst({
        where: {
          accountId: account.id,
          serviceId: offer.serviceId,
          offerKey: offer.key,
          scope: selectedScope.scope,
          scopeKey: selectedScope.scopeKey,
          status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
        },
      });
      if (!checkout) {
        throw new AppError('INTERNAL', 503, 'BILLING_RECURRING_ADDON_CHECKOUT_RETRY');
      }
      assertCheckoutIdentity(checkout, identity);
      const recovered = await recoverOpenCheckout(checkout, customer.stripeCustomerId, {
        prisma,
        stripe,
        livemode,
      });
      if (recovered.redirect) return recovered.redirect;
      if (!recovered.reusable) {
        throw new AppError('INTERNAL', 503, 'BILLING_RECURRING_ADDON_CHECKOUT_RETRY');
      }
    }
  }
  const metadata = recurringAddonMetadata(checkout, account);
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customer.stripeCustomerId,
      client_reference_id: checkout.id,
      success_url: urls.success,
      cancel_url: urls.cancel,
      allow_promotion_codes: false,
      automatic_tax: { enabled: false },
      tax_id_collection: { enabled: false },
      payment_method_collection: 'always',
      line_items: [{ price: catalog.stripePriceId, quantity: 1 }],
      metadata,
      subscription_data: { metadata },
    },
    { idempotencyKey: checkoutIdempotencyKey(checkout) },
  );
  assertStripeObjectLivemode(session, account.livemode);
  assertRecurringAddonMetadata(session.metadata, checkout, account);
  if (
    session.client_reference_id !== checkout.id ||
    stripeExternalId(session.customer) !== customer.stripeCustomerId ||
    session.mode !== 'subscription'
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CHECKOUT_DRIFT');
  }
  await prisma.$transaction([
    prisma.billingRecurringAddonCheckout.update({
      where: { id: checkout.id },
      data: {
        stripeCheckoutSessionId: session.id,
        status: BillingRecurringAddonCheckoutStatus.OPEN,
        expiresAt: new Date(session.expires_at * 1000),
      },
    }),
    prisma.orgAuditLog.create({
      data: {
        orgId: params.request.organisationId,
        actorUserId: params.request.userId,
        action: 'billing.recurring_addon_checkout_created',
        targetType: 'billing_recurring_addon_checkout',
        targetId: checkout.id,
        metadata: {
          service_id: offer.serviceId,
          offer_id: offer.id,
          scope: selectedScope.scope.toLowerCase(),
          scope_key: selectedScope.scopeKey,
          app_key_id: params.credential.id,
        },
      },
    }),
  ]);
  return redirect(session);
}
