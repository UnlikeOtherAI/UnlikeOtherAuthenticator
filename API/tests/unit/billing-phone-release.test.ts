import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { phoneReleaseVerdict } from '../../src/services/billing-phone-release.service.js';
import { recurringAddonMetadata } from '../../src/services/billing-recurring-addon-stripe-binding.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

function fixture() {
  const credential: VerifiedBillingAppKey = { id: 'worker', purpose: 'COMMERCIAL_WORKER', actorIssuer: 'https://api.example.test',
    actorAudience: 'https://authentication.unlikeotherai.com', actorKeyId: 'worker-key', actorPublicJwk: {}, checkoutReturnOrigins: [],
    service: { id: 'service', identifier: 'nessie', name: 'Nessie' } };
  const account = { id: 'account', stripeAccountId: 'acct_fixture', livemode: false };
  const checkout = { id: 'checkout', serviceId: 'service', offerId: 'phone-offer', offerKey: 'phone', orgId: 'company',
    teamId: null, requestedTeamId: 'team', subscribingUserId: null, scope: 'ORGANISATION' as const, scopeKey: 'company' };
  const metadata = recurringAddonMetadata(checkout, account);
  const local = { id: 'addon', accountId: account.id, livemode: false, stripeSubscriptionId: 'sub_phone', stripeItemId: 'si_phone',
    offerId: checkout.offerId, checkout, customer: { stripeCustomerId: 'cus_company' },
    catalog: { stripePriceId: 'price_phone', currency: 'EUR', monthlyAmountMinor: 1000n } };
  const resource = { id: 'resource', offerId: checkout.offerId, accountSid: `AC${'a'.repeat(32)}`,
    phoneNumberSid: `PN${'b'.repeat(32)}`, state: 'active' };
  const incident = { id: 'incident', serviceId: 'service', orgId: 'company', category: 'phone', accountId: account.id,
    resourceId: resource.id, addonSubscriptionId: local.id, invoiceId: 'in_phone', resolvedAt: null,
    graceEndsAt: new Date('2026-10-08T18:00:00Z') };
  const invoice = { id: 'in_phone', livemode: false, customer: 'cus_company', currency: 'eur',
    collection_method: 'charge_automatically', amount_due: 1299, amount_paid: 0, amount_remaining: 1299,
    status: 'open', total_taxes: [{ amount: 299 }], parent: { subscription_details: { subscription: 'sub_phone', metadata } },
    lines: { has_more: false, data: [{ quantity: 1, amount: 1000,
      pricing: { price_details: { price: 'price_phone' } }, parent: { subscription_item_details: { subscription_item: 'si_phone' } } }] } };
  const remote = { id: 'sub_phone', livemode: false, customer: 'cus_company', metadata, discounts: [],
    items: { data: [{ id: 'si_phone', quantity: 1, discounts: [], price: { id: 'price_phone',
      recurring: { interval: 'month', usage_type: 'licensed' } } }] } };
  const stages = ['initial', 'reminder', 'final_warning'].map((stage) => ({ id: stage, stage }));
  const receipts = stages.flatMap((stage) => ['alert', 'personal_assistant', 'email'].map((channel) => ({
    notificationId: stage.id, recipientUserId: 'owner', channel,
    acknowledgedAt: new Date(stage.stage === 'final_warning' ? '2026-10-12T18:00:00Z' : '2026-10-01T18:00:00Z'),
  })));
  const database = { $queryRaw: async () => [],
    billingStripeAccount: { upsert: async () => account },
    billingAppKey: { findFirst: async () => ({ ...credential, actorPublicJwk: credential.actorPublicJwk }) },
    clientDomain: { findFirst: async () => ({ domain: 'api.example.test' }) },
    organisation: { findFirst: async () => ({ id: 'company' }) },
    billingProductEnrollment: { findFirst: async () => ({ serviceId: 'service', orgId: 'company' }) },
    billingCommercialIncident: { findFirst: async () => incident, findUniqueOrThrow: async () => incident },
    billingSmsNumberResource: { findFirstOrThrow: async () => resource, findUniqueOrThrow: async () => resource },
    billingRecurringAddonSubscription: { findUniqueOrThrow: async () => local },
    billingCommercialNotification: { findMany: async () => stages },
    orgMember: { findMany: async () => [{ userId: 'owner' }] },
    billingCommercialAcknowledgement: { findMany: async () => receipts },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(database) };
  const stripe = { accounts: { retrieveCurrent: async () => ({ id: account.stripeAccountId }) },
    invoices: { retrieve: async () => invoice }, subscriptions: { retrieve: async () => remote } } as unknown as Stripe;
  return { credential, invoice, remote, receipts, resource, prisma: database as unknown as PrismaClient, stripe };
}

describe('fresh exact provider phone release eligibility', () => {
  async function verdict(data: ReturnType<typeof fixture>, now = new Date('2026-10-13T18:00:00Z')) {
    return phoneReleaseVerdict({ credential: data.credential,
      request: { product: 'nessie', organisation_id: 'company', incident_id: 'incident' } },
    { prisma: data.prisma, stripe: data.stripe, livemode: false, now: () => now });
  }
  it('keeps gross unpaid eligibility separate from the nominal price and binds the exact provider number', async () => {
    const data = fixture(); const result = await verdict(data);
    expect(result).toMatchObject({ authorized: true, resource_id: data.resource.id,
      account_sid: data.resource.accountSid, phone_number_sid: data.resource.phoneNumberSid });
    expect(result.valid_until).toBe('2026-10-13T18:00:10.000Z');
  });
  it('refuses a fresh paid invoice without treating it as broken identity binding', async () => {
    const data = fixture(); data.invoice.status = 'paid'; data.invoice.amount_paid = data.invoice.amount_due;
    data.invoice.amount_remaining = 0;
    expect(await verdict(data)).toMatchObject({ authorized: false, account_sid: null, phone_number_sid: null });
  });
  it('waits a full day after a delayed final transport acceptance and requires every warning channel', async () => {
    const data = fixture();
    expect(await verdict(data, new Date('2026-10-13T17:59:59Z'))).toMatchObject({ authorized: false });
    data.receipts.splice(data.receipts.findIndex((row) => row.channel === 'email' && row.notificationId === 'reminder'), 1);
    expect(await verdict(data)).toMatchObject({ authorized: false });
  });
  it('never issues permission for a different customer or a different subscription item', async () => {
    const data = fixture(); data.invoice.customer = 'cus_other'; await expect(verdict(data)).rejects.toThrow();
    const item = fixture(); item.remote.items.data[0]!.id = 'si_other'; await expect(verdict(item)).rejects.toThrow();
  });
});
