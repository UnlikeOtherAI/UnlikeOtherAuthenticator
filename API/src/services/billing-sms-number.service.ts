import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type BillingSmsNumberResource } from '@prisma/client';
import type Stripe from 'stripe';
import type { BillingSmsNumberBeginRequestV1, BillingSmsNumberV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential, lockSmsSubject, smsSubject, verifySmsActor } from './billing-sms-authority.service.js';
import { publicSmsQuote } from './billing-sms-quote.service.js';
import type { BillingSmsProvider } from './billing-sms-provider.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import { assertCanManageRecurringAddonScope } from './billing-recurring-addon-scope.service.js';
import { createRecurringAddonCheckout } from './billing-recurring-addon-checkout.service.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { refreshRecurringAddonSubscriptionProjection,
  recurringAddonSubscriptionInclude } from './billing-recurring-addon-subscription.service.js';
import { assertRecurringAddonMetadata } from './billing-recurring-addon-stripe-binding.service.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { assertPaidInvoice } from './billing-recurring-addon-webhook.service.js';
import { verifyStripeInvoiceCash } from './billing-stripe-payment-evidence.service.js';

export type SmsNumberDependencies = { prisma?: PrismaClient; stripe?: Stripe;
  stripeLivemode?: boolean; provider: BillingSmsProvider; now?: () => Date };

function checkoutUrl(value: string | null): string | null {
  if (value === null) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' ||
      url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_CHECKOUT_URL_INVALID');
  }
  return value; // Stripe's opaque fragment is part of the original hosted URL.
}

function binding(resource: BillingSmsNumberResource, product: string, credential: VerifiedBillingAppKey): void {
  if (product !== credential.service.identifier || resource.serviceId !== credential.service.id) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
  }
}

export async function readSmsNumber(input: { product: string; resource_id: string;
  credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsNumberV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const resource = await runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    const row = await tx.billingSmsNumberResource.findUnique({ where: { id: input.resource_id } });
    if (!row) throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
    binding(row, input.product, input.credential);
    return row;
  }, 'BILLING_SMS_RESOURCE_RETRY_EXHAUSTED');
  const quote = await prisma.billingSmsQuote.findUniqueOrThrow({ where: { id: resource.quoteId } });
  let state = resource.state as BillingSmsNumberV1['state'];
  let url: string | null = null;
  let authorized = false;
  if (!['ended', 'ending', 'refund_required', 'recovery_required'].includes(state)) {
    if (!resource.offerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_OFFER_UNAVAILABLE');
    const configured = deps.stripe ? { client: deps.stripe, livemode: deps.stripeLivemode ?? false }
    : requireStripeBillingEnabled();
    const stripe = deps.stripe ?? configured.client;
    const account = await resolveStripeAccountContext(stripe, deps.stripeLivemode ?? configured?.livemode ?? false, prisma);
    const subscription = await prisma.billingRecurringAddonSubscription.findFirst({ where: {
      offerId: resource.offerId, serviceId: resource.serviceId, orgId: resource.orgId,
      scope: 'ORGANISATION', accountId: account.id,
    }, include: recurringAddonSubscriptionInclude, orderBy: { createdAt: 'desc' } });
    if (subscription) {
      const refreshed = await refreshRecurringAddonSubscriptionProjection({ local: subscription, account },
        { prisma, stripe });
      const current = refreshed.local;
      authorized = Boolean(current.initialInvoicePaidAt && current.initialInvoiceId &&
        current.activationWebhookEventId && current.status === 'active' && !current.cancelAtPeriodEnd &&
        !current.entitlementDeactivatedAt && current.currentPeriodEnd &&
        current.currentPeriodEnd.getTime() > (deps.now?.() ?? new Date()).getTime());
      if (authorized && refreshed.remote) {
        const latestId = stripeExternalId(refreshed.remote.latest_invoice);
        if (!latestId) authorized = false;
        else {
          const invoice = await stripe.invoices.retrieve(latestId, { expand: ['lines.data.pricing.price_details.price'] });
          if (invoice.status !== 'paid') authorized = false;
          else {
            assertStripeObjectLivemode(invoice, account.livemode);
            if (invoice.id !== latestId || stripeExternalId(invoice.customer) !== current.customer.stripeCustomerId ||
                !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? '')) {
              throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_PAYMENT_BINDING_INVALID');
            }
            assertPaidInvoice(invoice, current, refreshed.remote,
              invoice.billing_reason as 'subscription_create' | 'subscription_cycle');
            await verifyStripeInvoiceCash(invoice, stripe);
          }
        }
      }
      state = authorized ? resource.phoneNumberSid ? 'active' : 'paid' : 'payment_pending';
    } else {
      const checkout = await prisma.billingRecurringAddonCheckout.findFirst({ where: {
        offerId: resource.offerId, accountId: account.id, orgId: resource.orgId, scope: 'ORGANISATION',
      }, include: { catalog: true, customer: true }, orderBy: { createdAt: 'desc' } });
      state = 'payment_required';
      if (checkout?.stripeCheckoutSessionId) {
        const session = await stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
        assertStripeObjectLivemode(session, account.livemode);
        assertRecurringAddonMetadata(session.metadata, checkout, account);
        if (session.id !== checkout.stripeCheckoutSessionId || session.client_reference_id !== checkout.id ||
            session.mode !== 'subscription' || stripeExternalId(session.customer) !== checkout.customer.stripeCustomerId) {
          throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_CHECKOUT_BINDING_INVALID');
        }
        if (session.status === 'open' && session.payment_status === 'unpaid') url = checkoutUrl(session.url);
        else if (session.status !== 'expired') state = 'payment_pending';
      } else if (checkout) state = 'payment_pending';
    }
  }
  // The paid projection is derived from the verified subscription, never from display quote expiry.
  return { resource_id: resource.id, organisation_id: resource.orgId, phone_number: resource.phoneNumber,
    state, quote: publicSmsQuote(quote), acquisition_authorized: authorized,
    checkout_url: url, disabled_reason: resource.recoveryReason };
}

export async function beginSmsNumber(input: { request: BillingSmsNumberBeginRequestV1;
  actorToken: string; credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsNumberV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const subject = smsSubject(input.request);
  const actor = await verifySmsActor({ subject: input.request, actorToken: input.actorToken,
    credential: input.credential, endpoint: '/billing/v1/sms/numbers/begin' });
  const viewer = await resolveBillingFundingViewer(subject, { prisma });
  assertCanManageRecurringAddonScope(viewer, 'ORGANISATION');
  const existing = await prisma.billingSmsNumberResource.findUnique({ where: { id: input.request.resource_id } });
  if (!existing) {
    const quote = await prisma.billingSmsQuote.findUniqueOrThrow({ where: { id: input.request.quote_id } });
    await deps.provider.assertAvailableMobile(quote.country, input.request.phone_number);
  }
  const configured = deps.stripe ? { client: deps.stripe, livemode: deps.stripeLivemode ?? false }
    : requireStripeBillingEnabled();
  const stripe = deps.stripe ?? configured.client;
  const livemode = deps.stripeLivemode ?? configured?.livemode ?? false;
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  const resource = await runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsSubject(tx, { subject: input.request, actor, credential: input.credential });
    const manager = await tx.orgMember.findUnique({ where: { orgId_userId: {
      orgId: input.request.organisation_id, userId: input.request.user_id,
    } }, select: { role: true } });
    if (!manager || !['owner', 'admin'].includes(manager.role)) {
      throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_ORGANISATION_MANAGER_REQUIRED');
    }
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.resource_id}, 0))::text`);
    if (await tx.billingSmsResourceCancellation.findUnique({ where: { resourceId: input.request.resource_id } })) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RESOURCE_ENDED');
    }
    const prior = await tx.billingSmsNumberResource.findUnique({ where: { id: input.request.resource_id } });
    if (prior) {
      binding(prior, input.request.product, input.credential);
      if (prior.orgId !== input.request.organisation_id || prior.quoteId !== input.request.quote_id ||
          prior.phoneNumber !== input.request.phone_number) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RESOURCE_BINDING_CONFLICT');
      }
      return prior;
    }
    const quote = await tx.billingSmsQuote.findUnique({ where: { id: input.request.quote_id } });
    if (!quote || quote.serviceId !== input.credential.service.id || quote.orgId !== input.request.organisation_id ||
        quote.direction !== 'monthly' || quote.destination !== null || quote.finalCurrency !== 'USD' ||
        quote.expiresAt.getTime() <= (deps.now?.() ?? new Date()).getTime()) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_QUOTE_NOT_ACCEPTABLE');
    }
    const minor = BigInt(quote.finalAmount.mul(100).toFixed(0));
    if (minor <= 0n || minor > 99_999_999n || !quote.finalAmount.mul(100).isInteger()) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_MONTHLY_AMOUNT_UNSUPPORTED');
    }
    const key = `sms-${createHash('sha256').update(input.request.resource_id).digest('hex')}`;
    const offer = await tx.billingRecurringAddonOffer.create({ data: {
      serviceId: input.credential.service.id, key, version: 1,
      name: `Mobile number ${input.request.phone_number}`, description: 'Monthly mobile phone number service.',
      monthlyAmountMinor: minor, currency: 'USD', resourceKind: 'sms_mobile_number', resourceId: input.request.resource_id,
    } });
    await tx.billingRecurringAddonCatalog.create({ data: { accountId: account.id, serviceId: offer.serviceId,
      offerId: offer.id, currency: 'USD', monthlyAmountMinor: minor, stripeLookupKey: `${key}:1:${account.id}` } });
    return tx.billingSmsNumberResource.create({ data: { id: input.request.resource_id,
      serviceId: input.credential.service.id, appKeyId: input.credential.id, orgId: input.request.organisation_id,
      quoteId: quote.id, phoneNumber: input.request.phone_number, country: quote.country,
      offerId: offer.id, state: 'payment_required' } });
  }, 'BILLING_SMS_RESOURCE_RETRY_EXHAUSTED');
  const status = await readSmsNumber({ product: input.request.product, resource_id: resource.id,
    credential: input.credential }, deps);
  if (status.state !== 'payment_required' || status.checkout_url) return status;
  if (!resource.offerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_OFFER_UNAVAILABLE');
  await createRecurringAddonCheckout({ request: { ...subject, offerId: resource.offerId },
    actorToken: input.actorToken, credential: input.credential, endpoint: '/billing/v1/sms/numbers/begin' },
  { prisma, stripe, stripeLivemode: livemode });
  return readSmsNumber({ product: input.request.product, resource_id: resource.id,
    credential: input.credential }, deps);
}
