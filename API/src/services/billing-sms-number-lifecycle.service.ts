import { Prisma } from '@prisma/client';
import type { BillingSmsNumberAttachRequestV1, BillingSmsNumberEndRequestV1,
  BillingSmsNumberEndResultV1, BillingSmsNumberV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential } from './billing-sms-authority.service.js';
import { readSmsNumber, type SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext,
  assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { recurringAddonSubscriptionInclude, refreshRecurringAddonSubscriptionProjection,
  assertRecurringAddonSubscriptionBinding } from './billing-recurring-addon-subscription.service.js';
import { assertRecurringAddonMetadata } from './billing-recurring-addon-stripe-binding.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export async function attachSmsNumber(input: { request: BillingSmsNumberAttachRequestV1;
  credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsNumberV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const status = await readSmsNumber({ ...input.request, credential: input.credential }, deps);
  if (!status.acquisition_authorized) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_PAYMENT_NOT_ACTIVE');
  const evidence = await deps.provider.ownedNumber(input.request.account_sid, input.request.phone_number_sid);
  if (!evidence || !evidence.sms || evidence.phone !== status.phone_number) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_ATTACHMENT_MISMATCH');
  }
  await runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_sms_number_resources
      WHERE id = ${input.request.resource_id} FOR UPDATE`);
    const row = await tx.billingSmsNumberResource.findUniqueOrThrow({ where: { id: input.request.resource_id } });
    if (row.serviceId !== input.credential.service.id ||
        !['payment_required', 'payment_pending', 'paid', 'active'].includes(row.state) ||
        (row.phoneNumberSid && (row.phoneNumberSid !== input.request.phone_number_sid ||
          row.accountSid !== input.request.account_sid))) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RESOURCE_BINDING_CONFLICT');
    }
    await tx.billingSmsNumberResource.update({ where: { id: row.id }, data: {
      accountSid: input.request.account_sid, phoneNumberSid: input.request.phone_number_sid, state: 'active',
    } });
  }, 'BILLING_SMS_RESOURCE_RETRY_EXHAUSTED');
  return readSmsNumber({ ...input.request, credential: input.credential }, deps);
}

export async function endSmsNumber(input: { request: BillingSmsNumberEndRequestV1;
  credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsNumberEndResultV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  if (input.request.product !== input.credential.service.identifier) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  }
  const observed = await prisma.billingSmsNumberResource.findUnique({ where: { id: input.request.resource_id } });
  if (observed && observed.serviceId !== input.credential.service.id) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
  }
  if (observed?.phoneNumberSid && !['ended', 'refund_required'].includes(observed.state)) {
    if (!observed.accountSid || await deps.provider.ownedNumber(observed.accountSid, observed.phoneNumberSid)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_PROVIDER_RELEASE_NOT_VERIFIED');
    }
  }
  const resource = await runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.resource_id}, 0))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_sms_number_resources
      WHERE id = ${input.request.resource_id} FOR UPDATE`);
    const row = await tx.billingSmsNumberResource.findUnique({ where: { id: input.request.resource_id } });
    if (!row) {
      if (input.request.reason !== 'acquisition_unavailable') {
        throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
      }
      const old = await tx.billingSmsResourceCancellation.findUnique({ where: { resourceId: input.request.resource_id } });
      if (old && old.serviceId !== input.credential.service.id) {
        throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
      }
      if (!old) await tx.billingSmsResourceCancellation.create({ data: {
        resourceId: input.request.resource_id, serviceId: input.credential.service.id, appKeyId: input.credential.id,
      } });
      return null;
    }
    if (row.serviceId !== input.credential.service.id) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
    }
    if (row.phoneNumberSid !== observed?.phoneNumberSid || row.accountSid !== observed?.accountSid) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RESOURCE_BINDING_CHANGED');
    }
    if (!['ended', 'refund_required'].includes(row.state)) {
      await tx.billingSmsNumberResource.update({ where: { id: row.id }, data: { state: 'ending',
        recoveryReason: input.request.reason } });
    }
    return row;
  }, 'BILLING_SMS_RESOURCE_RETRY_EXHAUSTED');
  if (!resource) return { resource_id: input.request.resource_id, state: 'ended', acquisition_authorized: false };
  if (['ended', 'refund_required'].includes(resource.state)) {
    return readSmsNumber({ ...input.request, credential: input.credential }, deps);
  }
  if (!resource.offerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_OFFER_UNAVAILABLE');
  const configured = deps.stripe ? { client: deps.stripe, livemode: deps.stripeLivemode ?? false }
    : requireStripeBillingEnabled();
  const stripe = deps.stripe ?? configured.client;
  const account = await resolveStripeAccountContext(stripe, deps.stripeLivemode ?? configured?.livemode ?? false, prisma);
  const subscription = await prisma.billingRecurringAddonSubscription.findFirst({ where: {
    offerId: resource.offerId, serviceId: resource.serviceId, orgId: resource.orgId, accountId: account.id,
  }, include: recurringAddonSubscriptionInclude, orderBy: { createdAt: 'desc' } });
  let refundRequired = false;
  if (subscription) {
    const current = await refreshRecurringAddonSubscriptionProjection({ local: subscription, account }, { prisma, stripe });
    refundRequired = input.request.reason === 'acquisition_unavailable' && Boolean(current.local.initialInvoicePaidAt);
    if (current.remote && current.remote.status !== 'canceled') {
      const canceled = await stripe.subscriptions.cancel(current.remote.id, { invoice_now: false, prorate: false },
        { idempotencyKey: `uoa:sms-number-end:${resource.id}` });
      assertRecurringAddonSubscriptionBinding(current.local, canceled, account);
      if (canceled.status !== 'canceled') throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_CANCELLATION_PENDING');
      await prisma.billingRecurringAddonSubscription.update({ where: { id: subscription.id },
        data: { status: 'canceled', entitlementDeactivatedAt: new Date() } });
    }
  } else {
    const checkout = await prisma.billingRecurringAddonCheckout.findFirst({ where: {
      offerId: resource.offerId, accountId: account.id,
    }, include: { catalog: true, customer: true }, orderBy: { createdAt: 'desc' } });
    if (checkout && !checkout.stripeCheckoutSessionId) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_CHECKOUT_OUTCOME_UNKNOWN');
    }
    if (checkout?.stripeCheckoutSessionId) {
      let session = await stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
      assertStripeObjectLivemode(session, account.livemode);
      assertRecurringAddonMetadata(session.metadata, checkout, account);
      if (session.id !== checkout.stripeCheckoutSessionId || session.client_reference_id !== checkout.id ||
          session.mode !== 'subscription' || stripeExternalId(session.customer) !== checkout.customer.stripeCustomerId) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_CHECKOUT_BINDING_INVALID');
      }
      if (session.status === 'open' && session.payment_status === 'unpaid') {
        session = await stripe.checkout.sessions.expire(session.id, {},
          { idempotencyKey: `uoa:sms-number-expire:${resource.id}` });
      }
      if (session.status !== 'expired' || session.payment_status !== 'unpaid') {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_PAYMENT_RECONCILIATION_REQUIRED');
      }
      await prisma.billingRecurringAddonCheckout.update({ where: { id: checkout.id }, data: { status: 'EXPIRED' } });
    }
  }
  await prisma.billingSmsNumberResource.update({ where: { id: resource.id }, data: {
    state: refundRequired ? 'refund_required' : 'ended',
    recoveryReason: refundRequired ? 'payment_without_acquired_number' : null,
  } });
  return readSmsNumber({ ...input.request, credential: input.credential }, deps);
}
