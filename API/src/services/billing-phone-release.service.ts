import type { PhoneReleaseRequestV1, PhoneReleaseVerdictV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockCommercialAuthority } from './billing-product-authority.service.js';
import { phoneWarningsAccepted } from './billing-commercial-events.service.js';
import { storageRuntime, type StorageDependencies } from './billing-storage-mandate.service.js';
import { resolveStripeAccountContext, assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { assertRecurringAddonSubscriptionBinding, recurringAddonSubscriptionInclude }
  from './billing-recurring-addon-subscription.service.js';
import { assertRecurringAddonMetadata } from './billing-recurring-addon-stripe-binding.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

/** Exact fresh verdict immediately before the product's provider release. */
export async function phoneReleaseVerdict(input: { request: PhoneReleaseRequestV1;
  credential: VerifiedBillingAppKey }, deps?: StorageDependencies): Promise<PhoneReleaseVerdictV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { stripe, livemode } = storageRuntime(deps);
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  const prepared = await prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential: input.credential, product: input.request.product,
      organisationId: input.request.organisation_id, purpose: 'COMMERCIAL_WORKER' });
    const incident = await tx.billingCommercialIncident.findFirst({ where: { id: input.request.incident_id,
      serviceId: input.credential.service.id, orgId: input.request.organisation_id, category: 'phone' } });
    if (!incident?.resourceId || !incident.addonSubscriptionId || incident.accountId !== account.id) {
      throw new AppError('NOT_FOUND', 404);
    }
    const resource = await tx.billingSmsNumberResource.findFirstOrThrow({ where: { id: incident.resourceId,
      serviceId: incident.serviceId, orgId: incident.orgId } });
    const local = await tx.billingRecurringAddonSubscription.findUniqueOrThrow({ where: {
      id: incident.addonSubscriptionId }, include: recurringAddonSubscriptionInclude });
    if (local.offerId !== resource.offerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PHONE_RELEASE_BINDING_INVALID');
    return { incident, resource, local };
  });
  const checkedAt = deps?.now?.() ?? new Date();
  const [invoice, remote] = await Promise.all([stripe.invoices.retrieve(prepared.incident.invoiceId),
    stripe.subscriptions.retrieve(prepared.local.stripeSubscriptionId)]);
  assertStripeObjectLivemode(invoice, livemode);
  assertRecurringAddonSubscriptionBinding(prepared.local, remote, account);
  assertRecurringAddonMetadata(invoice.parent?.subscription_details?.metadata, prepared.local.checkout, account);
  const line = invoice.lines.data[0];
  const expected = Number(prepared.local.catalog.monthlyAmountMinor);
  const bound = invoice.id === prepared.incident.invoiceId &&
    stripeExternalId(invoice.customer) === prepared.local.customer.stripeCustomerId &&
    stripeExternalId(invoice.parent?.subscription_details?.subscription) === remote.id &&
    invoice.currency.toUpperCase() === prepared.local.catalog.currency &&
    invoice.collection_method === 'charge_automatically' &&
    Number.isSafeInteger(invoice.amount_due) && invoice.amount_due >= 0 &&
    invoice.amount_paid >= 0 && invoice.amount_paid < invoice.amount_due &&
    !invoice.lines.has_more && invoice.lines.data.length === 1 && line?.quantity === 1 &&
    line.amount === expected && line.parent?.subscription_item_details?.subscription_item === prepared.local.stripeItemId &&
    stripeExternalId(line.pricing?.price_details?.price) === prepared.local.catalog.stripePriceId;
  if (!bound) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PHONE_RELEASE_INVOICE_INVALID');
  return prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential: input.credential, product: input.request.product,
      organisationId: input.request.organisation_id, purpose: 'COMMERCIAL_WORKER' });
    await tx.$queryRaw`SELECT id FROM billing_commercial_incidents WHERE id=${prepared.incident.id} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM billing_sms_number_resources WHERE id=${prepared.resource.id} FOR SHARE`;
    const incident = await tx.billingCommercialIncident.findUniqueOrThrow({ where: { id: prepared.incident.id } });
    const resource = await tx.billingSmsNumberResource.findUniqueOrThrow({ where: { id: prepared.resource.id } });
    const now = deps?.now?.() ?? new Date();
    const authorized = !incident.resolvedAt && incident.graceEndsAt <= now && invoice.status === 'open' &&
      invoice.amount_remaining > 0 && resource.state !== 'ended' && resource.accountSid === prepared.resource.accountSid &&
      resource.phoneNumberSid === prepared.resource.phoneNumberSid && Boolean(resource.accountSid && resource.phoneNumberSid) &&
      checkedAt.getTime() + 10_000 > now.getTime() && await phoneWarningsAccepted(tx, incident.id, incident.orgId, now);
    return { ...input.request, schema_version: 1, resource_id: resource.id, authorized,
      account_sid: authorized ? resource.accountSid : null, phone_number_sid: authorized ? resource.phoneNumberSid : null,
      valid_until: new Date(checkedAt.getTime() + 10_000).toISOString() };
  });
}
