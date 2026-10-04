import type { PrismaClient, BillingCreditTopUpCheckout } from '@prisma/client';
import type Stripe from 'stripe';

import type { BillingCreditPurchaseState, BillingCreditPurchaseStatusV1, BillingCustomerLocale, BillingHostedRedirectResponse } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveCreditAccount, resolveCreditCollectionContext } from './billing-credit-account.service.js';
import { assertCreditCheckoutSessionBinding } from './billing-credit-checkout-recovery.service.js';
import type { CreditFundingActionRequest } from './billing-credit-funding-context.service.js';
import { assertCreditFundingMetadata } from './billing-credit-funding-binding.service.js';
import { exactMinor, requireUsd } from './billing-credit-funding-webhook-validation.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import { isOrganisationBillingManager, resolveOrgBillingResponsibility } from './billing-org-responsibility.service.js';
import { billingCreditPaymentCopy } from './billing-payment-copy.catalog.js';
import { assertStripeObjectLivemode, type StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type PurchaseStripe = Pick<Stripe, 'checkout' | 'paymentIntents'>;

type PurchaseEvidence = {
  state: BillingCreditPurchaseState;
  continuation?: BillingHostedRedirectResponse;
};

function safeCheckoutUrl(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com'
      || url.username || url.password || url.port
    ) return null;
    const normalized = url.toString();
    return normalized.length <= 2048 ? normalized : null;
  } catch {
    return null;
  }
}

function continuationForOpenSession(
  session: Stripe.Checkout.Session,
  checkout: BillingCreditTopUpCheckout,
): BillingHostedRedirectResponse | undefined {
  if (session.status !== 'open') return undefined;
  const redirectUrl = safeCheckoutUrl(session.url);
  return redirectUrl ? { redirect_url: redirectUrl, purchase_id: checkout.id } : undefined;
}

/** Read-only evidence: only the committed credit entry can prove added credits. */
export async function readCreditPurchaseEvidence(params: {
  checkout: BillingCreditTopUpCheckout;
  account: StripeAccountContext;
  customerStripeId: string | null;
  stripe: PurchaseStripe | null;
}): Promise<PurchaseEvidence> {
  const { checkout, account, customerStripeId, stripe } = params;
  if (checkout.status === 'COMPLETE') {
    return { state: checkout.creditEntryId && checkout.completionWebhookEventId ? 'succeeded' : 'needs_review' };
  }
  if (checkout.status === 'EXPIRED' || checkout.status === 'ABANDONED') return { state: 'expired' };
  if (!stripe || !customerStripeId) return { state: 'needs_review' };
  if (!checkout.stripeCheckoutSessionId) return { state: 'processing' };
  try {
    const session = await stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
    assertCreditCheckoutSessionBinding(session, checkout, 'top_up', customerStripeId, account);
    if (session.id !== checkout.stripeCheckoutSessionId
      || session.amount_total === null || session.currency === null
      || exactMinor(session.amount_total) !== checkout.paymentAmountMinor
      || requireUsd(session.currency) !== 'USD') return { state: 'needs_review' };
    if (session.status === 'expired') return { state: 'expired' };
    const continuation = continuationForOpenSession(session, checkout);
    const intentId = stripeExternalId(session.payment_intent);
    if (checkout.stripePaymentIntentId && checkout.stripePaymentIntentId !== intentId) return { state: 'needs_review' };
    if (!intentId) return { state: session.status === 'open' ? 'open' : 'processing', ...(continuation ? { continuation } : {}) };
    const intent = await stripe.paymentIntents.retrieve(intentId);
    assertStripeObjectLivemode(intent, account.livemode);
    assertCreditFundingMetadata(intent.metadata, {
      localType: 'top_up', localId: checkout.id,
      serviceId: checkout.serviceId, appKeyId: checkout.appKeyId,
      creditAccountId: checkout.creditAccountId,
    });
    if (intent.id !== intentId || stripeExternalId(intent.customer) !== customerStripeId
      || exactMinor(intent.amount) !== checkout.paymentAmountMinor
      || requireUsd(intent.currency) !== 'USD') return { state: 'needs_review' };
    let state: BillingCreditPurchaseState;
    switch (intent.status) {
      case 'requires_action': state = 'requires_action'; break;
      case 'processing':
      case 'succeeded': state = 'processing'; break;
      case 'canceled': state = 'failed'; break;
      case 'requires_payment_method': state = intent.last_payment_error ? 'failed' : 'open'; break;
      default: state = session.status === 'open' ? 'open' : 'processing';
    }
    return { state, ...(continuation ? { continuation } : {}) };
  } catch {
    return { state: 'needs_review' };
  }
}

export async function readCreditPurchaseState(params: Parameters<typeof readCreditPurchaseEvidence>[0]): Promise<BillingCreditPurchaseState> {
  return (await readCreditPurchaseEvidence(params)).state;
}

type Dependencies = {
  prisma?: PrismaClient;
  resolveEntitlement?: typeof resolveEffectiveTariffContext;
  resolveViewer?: typeof resolveBillingFundingViewer;
  resolveResponsibility?: typeof resolveOrgBillingResponsibility;
  isOrganisationManager?: typeof isOrganisationBillingManager;
  resolveCollection?: typeof resolveCreditCollectionContext;
  resolveAccount?: typeof resolveCreditAccount;
  readState?: typeof readCreditPurchaseState;
  readEvidence?: typeof readCreditPurchaseEvidence;
};

export async function getBillingCreditPurchaseStatus(params: {
  request: CreditFundingActionRequest & { purchaseId: string };
  credential: VerifiedBillingAppKey;
  actorToken: string;
  endpoint: BillingActorEndpoint;
  locale?: BillingCustomerLocale;
  presentationEnabled?: boolean;
}, deps: Dependencies = {}): Promise<BillingCreditPurchaseStatusV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  await (deps.resolveEntitlement ?? resolveEffectiveTariffContext)(params, { prisma });
  const viewer = await (deps.resolveViewer ?? resolveBillingFundingViewer)(params.request, { prisma });
  const responsibility = await (deps.resolveResponsibility ?? resolveOrgBillingResponsibility)(
    { organisationId: params.request.organisationId }, { prisma },
  );
  const manager = responsibility.active
    ? await (deps.isOrganisationManager ?? isOrganisationBillingManager)(params.request, { prisma })
    : viewer.billingManager;
  if (!manager) throw new AppError('FORBIDDEN', 403, 'BILLING_MANAGER_REQUIRED');
  const collection = await (deps.resolveCollection ?? resolveCreditCollectionContext)(params.request, { prisma });
  const account = await (deps.resolveAccount ?? resolveCreditAccount)({
    account: collection.account, organisationId: params.request.organisationId, teamId: params.request.teamId,
  }, { prisma });
  const checkout = await prisma.billingCreditTopUpCheckout.findFirst({
    where: {
      id: params.request.purchaseId, accountId: collection.account.id,
      creditAccountId: account.id, customerId: account.customerId,
      serviceId: params.credential.service.id, appKeyId: params.credential.id,
    },
    include: { customer: { select: { stripeCustomerId: true } } },
  });
  if (!checkout) throw new AppError('NOT_FOUND', 404, 'BILLING_PURCHASE_NOT_FOUND');
  const evidence = deps.readEvidence
    ? await deps.readEvidence({ checkout, account: collection.account,
      customerStripeId: checkout.customer.stripeCustomerId, stripe: collection.stripe ?? null })
    : deps.readState
      ? { state: await deps.readState({ checkout, account: collection.account,
        customerStripeId: checkout.customer.stripeCustomerId, stripe: collection.stripe ?? null }) }
      : await readCreditPurchaseEvidence({ checkout, account: collection.account,
        customerStripeId: checkout.customer.stripeCustomerId, stripe: collection.stripe ?? null });
  const copy = billingCreditPaymentCopy(params.locale)[evidence.state];
  return {
    schema_version: 1, purchase_id: checkout.id, state: evidence.state,
    title: copy.title, message: copy.message, awaiting_confirmation: evidence.state === 'processing',
    ...(params.presentationEnabled && evidence.continuation
      ? { continuation: evidence.continuation }
      : {}),
  };
}
