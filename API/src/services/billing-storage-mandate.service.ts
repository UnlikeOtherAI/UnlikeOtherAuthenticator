import { BillingAssignmentScope, type PrismaClient, type BillingStorageMandate } from '@prisma/client';
import type Stripe from 'stripe';
import type { ProductEntitlementRequest } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { authorizeBillingCustomerAction, BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';
import { commercialMember, lockCommercialAuthority } from './billing-product-authority.service.js';
import { privateCompanyPolicy } from './billing-product-private-policy.service.js';
import { verifyStoragePrice } from './billing-storage-catalog.service.js';
import { ensureStripeCustomer } from './billing-stripe-checkout-state.service.js';
import { assertStripeObjectLivemode, requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export const STORAGE_CONSENT_VERSION = 'company-storage-auto-expansion-v1';
export const STORAGE_CONSENT_TEXT = 'Authorize automatic monthly storage charges per whole 1 TB block and automatic additional blocks when company usage exceeds capacity. The initial purchase establishes the separate monthly subscription renewal date shown by Stripe; additional blocks are prorated immediately and keep that date. Storage is charged from the first block. This consent does not authorize inference or seat payments.';
export type StorageDependencies = { prisma?: PrismaClient; stripe?: Stripe; livemode?: boolean; now?: () => Date };
export function storageRuntime(deps?: StorageDependencies) {
  const configured = deps?.stripe ? null : requireStripeBillingEnabled();
  return { stripe: deps?.stripe ?? configured!.client, livemode: deps?.livemode ?? configured!.livemode };
}

function checkoutUrl(value: string | null) {
  if (!value) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_PENDING');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_URL_INVALID');
  }
  return value;
}

export async function readStorageSetup(input: { request: ProductEntitlementRequest;
  credential: VerifiedBillingAppKey; actorToken: string }, deps?: StorageDependencies) {
  const { request, credential } = input;
  const actor = await verifyBillingActor({ token: input.actorToken, credential, endpoint: '/billing/v1/storage',
    request: { product: request.product, organisationId: request.organisation_id,
      teamId: request.team_id, userId: request.user_id } });
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product,
      organisationId: request.organisation_id, purpose: 'CUSTOMER_LIFECYCLE' });
    const manager = await commercialMember(tx, { organisationId: request.organisation_id,
      teamId: request.team_id, userId: request.user_id, tokenVersion: actor.tv });
    if (!manager) return { schema_version: 1, can_manage: false, setup: null };
    if (await privateCompanyPolicy(tx, credential.service.id, request.organisation_id, new Date())) {
      return { schema_version: 1, can_manage: true, setup: null, state: 'cost_evidence_required' };
    }
    const region = await tx.billingOrganisationRegion.findUnique({ where: { orgId: request.organisation_id } });
    if (!region) return { schema_version: 1, can_manage: true, setup: null, state: 'billing_region_required' };
    const catalog = await tx.billingStorageCatalog.findFirst({ where: { serviceId: credential.service.id,
      currency: region.currency }, orderBy: { createdAt: 'desc' } });
    if (!catalog) return { schema_version: 1, can_manage: true, setup: null, state: 'catalog_required' };
    return { schema_version: 1, can_manage: true, state: 'setup_available', setup: {
      unit_amount_minor: catalog.unitAmountMinor.toString(), currency: catalog.currency,
      block_bytes: '1000000000000', cadence: 'month', current_cycle_proration_minor: '0',
      consent_text: STORAGE_CONSENT_TEXT, consent_version: STORAGE_CONSENT_VERSION,
      action: { method: 'POST', path: '/billing/v1/storage/mandate', body: {
        ...request, catalog_id: catalog.id, consent_version: STORAGE_CONSENT_VERSION, accepted: true,
      } },
    } };
  });
}

export async function createStorageMandate(input: { request: ProductEntitlementRequest & {
  catalog_id: string; consent_version: string; accepted: true };
  credential: VerifiedBillingAppKey; actorToken: string }, deps?: StorageDependencies) {
  const { request, credential } = input;
  if (!request.accepted || request.consent_version !== STORAGE_CONSENT_VERSION) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_STORAGE_CONSENT_REQUIRED');
  }
  const actor = await verifyBillingActor({ token: input.actorToken, credential, endpoint: '/billing/v1/storage/mandate',
    request: { product: request.product, organisationId: request.organisation_id,
      teamId: request.team_id, userId: request.user_id } });
  const prisma = deps?.prisma ?? getAdminPrisma();
  const runtime = storageRuntime(deps);
  const account = await resolveStripeAccountContext(runtime.stripe, runtime.livemode, prisma);
  const prepared = await prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product,
      organisationId: request.organisation_id, purpose: 'CUSTOMER_LIFECYCLE' });
    const manager = await commercialMember(tx, { organisationId: request.organisation_id,
      teamId: request.team_id, userId: request.user_id, tokenVersion: actor.tv });
    if (!manager) throw new AppError('FORBIDDEN', 403, 'BILLING_STORAGE_COMPANY_MANAGER_REQUIRED');
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${request.organisation_id} FOR UPDATE`;
    if (await privateCompanyPolicy(tx, credential.service.id, request.organisation_id, new Date())) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_COST_EVIDENCE_REQUIRED');
    }
    const region = await tx.billingOrganisationRegion.findUnique({ where: { orgId: request.organisation_id } });
    const catalog = await tx.billingStorageCatalog.findFirst({ where: { id: request.catalog_id,
      serviceId: credential.service.id, accountId: account.id, currency: region?.currency ?? '' } });
    if (!catalog) throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_CATALOG_REQUIRED');
    const action = await authorizeBillingCustomerAction({ credential, actor, organisationId: request.organisation_id,
      teamId: request.team_id, userId: request.user_id, authorityScope: BillingAssignmentScope.ORGANISATION,
      operation: BILLING_CUSTOMER_ACTION.STORAGE_MANDATE_SETUP, request }, { prisma: tx });
    const customer = await tx.billingStripeCustomer.upsert({ where: { accountId_scopeKey: {
      accountId: account.id, scopeKey: request.organisation_id,
    } }, create: { accountId: account.id, scope: 'ORGANISATION', scopeKey: request.organisation_id,
      orgId: request.organisation_id, teamId: null }, update: {} });
    const user = await tx.user.findUniqueOrThrow({ where: { id: request.user_id } });
    const org = await tx.organisation.findUniqueOrThrow({ where: { id: request.organisation_id } });
    return { action, catalog, customer, user, org };
  });
  await verifyStoragePrice(runtime.stripe, { priceId: prepared.catalog.stripePriceId,
    currency: prepared.catalog.currency, unitAmountMinor: prepared.catalog.unitAmountMinor,
    product: credential.service.identifier, account });
  const customer = await ensureStripeCustomer({ customer: prepared.customer, account,
    email: prepared.user.email ?? '', name: prepared.org.name, orgId: request.organisation_id,
    teamId: null, scope: 'ORGANISATION', scopeKey: request.organisation_id }, { prisma, stripe: runtime.stripe });
  if (!customer.stripeCustomerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_CUSTOMER_UNRESOLVED');
  const origin = credential.checkoutReturnOrigins[0];
  if (!origin) throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_RETURN_ORIGIN_REQUIRED');
  const mandate = await prisma.billingStorageMandate.upsert({ where: { actionIntentId: prepared.action.id },
    create: { serviceId: credential.service.id, orgId: request.organisation_id, accountId: account.id,
      catalogId: prepared.catalog.id, appKeyId: credential.id, actionIntentId: prepared.action.id,
      requestedByUserId: request.user_id, requestedTeamId: request.team_id,
      consentVersion: STORAGE_CONSENT_VERSION, consentTerms: { text: STORAGE_CONSENT_TEXT,
        unit_amount_minor: prepared.catalog.unitAmountMinor.toString(), currency: prepared.catalog.currency,
        automatic_expansion: true, initial_monthly_cycle: 'stripe_initial_attempt_period',
        expansion_proration: 'immediate_keep_renewal_date' },
      stripeCustomerId: customer.stripeCustomerId, successUrl: `${origin}/admin/billing`,
      cancelUrl: `${origin}/admin/billing` }, update: {} });
  if (mandate.stripeCheckoutId) {
    const old = await runtime.stripe.checkout.sessions.retrieve(mandate.stripeCheckoutId);
    if (old.status !== 'open') return { mandate_id: mandate.id, state: mandate.state, url: null };
    return { mandate_id: mandate.id, state: 'open', url: checkoutUrl(old.url) };
  }
  if (Date.now() - mandate.createdAt.getTime() >= 23 * 3_600_000) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_RECONCILIATION_REQUIRED');
  }
  const metadata = { uoa_storage_mandate_id: mandate.id, uoa_service: credential.service.identifier };
  const checkout = await runtime.stripe.checkout.sessions.create({ mode: 'setup',
    customer: customer.stripeCustomerId, currency: prepared.catalog.currency.toLowerCase(),
    payment_method_types: ['card'], success_url: mandate.successUrl, cancel_url: mandate.cancelUrl,
    client_reference_id: mandate.id, metadata, setup_intent_data: { metadata },
    custom_text: { submit: { message: `${STORAGE_CONSENT_TEXT} Monthly unit price: ${prepared.catalog.currency} ` +
      `${(prepared.catalog.unitAmountMinor / 100n).toString()}.${(prepared.catalog.unitAmountMinor % 100n).toString().padStart(2, '0')}.` } },
  }, { idempotencyKey: `uoa:storage-mandate:${mandate.id}` });
  assertStripeObjectLivemode(checkout, account.livemode);
  if (checkout.mode !== 'setup' || stripeExternalId(checkout.customer) !== mandate.stripeCustomerId ||
    checkout.client_reference_id !== mandate.id || checkout.metadata?.uoa_storage_mandate_id !== mandate.id) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_BINDING_INVALID');
  }
  await prisma.billingStorageMandate.updateMany({ where: { id: mandate.id, state: 'creating' },
    data: { stripeCheckoutId: checkout.id, state: 'open' } });
  return { mandate_id: mandate.id, state: 'open', url: checkoutUrl(checkout.url) };
}

export async function verifyStorageSetup(mandate: BillingStorageMandate, stripe: Stripe, livemode: boolean) {
  if (!mandate.stripeCheckoutId) return null;
  const session = await stripe.checkout.sessions.retrieve(mandate.stripeCheckoutId);
  assertStripeObjectLivemode(session, livemode);
  if (session.mode !== 'setup' || session.client_reference_id !== mandate.id ||
    session.metadata?.uoa_storage_mandate_id !== mandate.id || stripeExternalId(session.customer) !== mandate.stripeCustomerId) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_BINDING_INVALID');
  }
  const setupId = stripeExternalId(session.setup_intent);
  if (session.status !== 'complete' || !setupId) return null;
  const setup = await stripe.setupIntents.retrieve(setupId);
  assertStripeObjectLivemode(setup, livemode);
  const paymentMethodId = stripeExternalId(setup.payment_method);
  if (setup.status !== 'succeeded' || setup.usage !== 'off_session' || !paymentMethodId ||
    setup.metadata?.uoa_storage_mandate_id !== mandate.id || stripeExternalId(setup.customer) !== mandate.stripeCustomerId) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_INTENT_INVALID');
  }
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  assertStripeObjectLivemode(method, livemode);
  if (stripeExternalId(method.customer) !== mandate.stripeCustomerId || method.type !== 'card') {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_PAYMENT_METHOD_INVALID');
  }
  return { setupId, paymentMethodId };
}
