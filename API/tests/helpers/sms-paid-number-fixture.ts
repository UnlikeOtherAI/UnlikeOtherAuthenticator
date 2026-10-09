import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getPublicBaseUrl } from '../../src/config/env.js';
import { recurringAddonMetadata } from '../../src/services/billing-recurring-addon-stripe-binding.service.js';
import { smsAccount, smsCredential, smsIds, smsPhone, seedSmsFinance } from './sms-financial-fixture.js';
import { BillingSmsProvider } from '../../src/services/billing-sms-provider.service.js';

export async function smsPaidNumberFixture(prisma: PrismaClient) {
  await seedSmsFinance(prisma, false);
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'synthetic', alg: 'RS256', use: 'sig' };
  const lifecycle = { ...smsCredential, id: smsIds.lifecycle, purpose: 'CUSTOMER_LIFECYCLE' as const,
    actorPublicJwk: jwk, checkoutReturnOrigins: ['https://app.example.test'] };
  const entitlement = { ...lifecycle, id: 'sms-entitlement', purpose: 'ENTITLEMENT' as const,
    checkoutReturnOrigins: [] };
  await prisma.billingAppKey.create({ data: { id: entitlement.id, serviceId: smsIds.service,
    purpose: 'ENTITLEMENT', name: 'SMS assertion fixture', keyPrefix: entitlement.id, secretDigest: entitlement.id,
    actorIssuer: entitlement.actorIssuer, actorAudience: entitlement.actorAudience, actorKeyId: 'synthetic', actorPublicJwk: jwk } });
  await prisma.billingAppKey.update({ where: { id: smsIds.lifecycle }, data: { actorPublicJwk: jwk } });
  const now = new Date();
  const end = new Date(now.getTime() + 3_600_000);
  const monthly = await prisma.billingSmsQuote.create({ data: { commercialPolicyVersion: 'synthetic-policy', monthlyFeeEur: '7.25', messageMarkupBps: 2700, id: 'sms-monthly-quote',
    serviceId: smsIds.service, appKeyId: entitlement.id, orgId: smsIds.org, country: 'CZ', direction: 'monthly',
    providerAmount: '2.2', providerCurrency: 'USD', providerSource: 'https://pricing.twilio.com/v1/PhoneNumbers/Countries/CZ',
    providerObservedAt: now, fxSnapshotId: smsIds.fx, finalAmount: '9.75', finalCurrency: 'USD',
    rateBasis: 'monthly_mobile', expiresAt: new Date(now.getTime() - 1000) } });
  const outboundPolicy = await prisma.billingSmsRoutePolicy.create({ data: { id: 'sms-outbound-policy',
    accountSid: smsAccount, country: 'CZ', direction: 'outbound', currency: 'USD',
    additionalPerSegment: '0.002', additionalPerMessage: '0.001',
    source: 'https://www.twilio.com/docs/messaging/api/pricing', evidenceDigest: 'e'.repeat(64),
    expiresAt: end, acceptedByUserId: smsIds.user, acceptanceReason: 'Synthetic route bound' } });
  const outbound = await prisma.billingSmsQuote.create({ data: { commercialPolicyVersion: 'synthetic-policy', monthlyFeeEur: '7.25', messageMarkupBps: 2700, id: 'sms-outbound-quote',
    serviceId: smsIds.service, appKeyId: entitlement.id, orgId: smsIds.org, country: 'CZ', direction: 'outbound',
    destination: '+420777000002', providerAmount: '0.01', providerBoundAmount: '0.013', providerCurrency: 'USD',
    providerSource: 'https://pricing.twilio.com/v1/Messaging/Countries/CZ', providerObservedAt: now,
    fxSnapshotId: smsIds.fx, routePolicyId: outboundPolicy.id, finalAmount: '0.016510000', finalCurrency: 'USD',
    rateBasis: 'maximum_mobile_carrier', expiresAt: end } });
  const offer = await prisma.billingRecurringAddonOffer.create({ data: { id: 'sms-offer', serviceId: smsIds.service,
    key: 'sms-fixture', version: 1, name: 'Mobile number', description: 'Synthetic exact number',
    monthlyAmountMinor: 975n, currency: 'USD', resourceKind: 'sms_mobile_number', resourceId: smsIds.number } });
  const catalog = await prisma.billingRecurringAddonCatalog.create({ data: { id: 'sms-catalog',
    accountId: smsIds.account, serviceId: smsIds.service, offerId: offer.id, currency: 'USD', monthlyAmountMinor: 975n,
    stripeLookupKey: 'sms-fixture:1', stripeProductId: 'prod_sms', stripePriceId: 'price_sms' } });
  const customer = await prisma.billingStripeCustomer.create({ data: { id: 'sms-org-customer',
    accountId: smsIds.account, orgId: smsIds.org, scope: 'ORGANISATION', scopeKey: smsIds.org,
    stripeCustomerId: 'cus_sms' } });
  let checkout!: Awaited<ReturnType<PrismaClient['billingRecurringAddonCheckout']['create']>>;
  await prisma.$transaction(async (tx) => {
    // Seed a verified paid opening subscription; service calls below independently verify remote cash.
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.billingStripeWebhookEvent.create({ data: { id: 'sms-checkout-event', accountId: smsIds.account,
      stripeEventId: 'evt_sms_checkout', type: 'checkout.session.completed', apiVersion: '2026-06-24.dahlia', livemode: false,
      stripeCreatedAt: now, stripeObjectId: 'cs_sms', stripeObjectStatus: 'complete', stripeCustomerId: 'cus_sms',
      stripeSubscriptionId: 'sub_sms', stripeCheckoutSessionId: 'cs_sms' } });
    checkout = await tx.billingRecurringAddonCheckout.create({ data: { id: 'sms-checkout', accountId: smsIds.account,
      appKeyId: smsIds.lifecycle, customerId: customer.id, catalogId: catalog.id, serviceId: smsIds.service,
      offerId: offer.id, offerKey: offer.key, orgId: smsIds.org, requestedTeamId: smsIds.team,
      scope: 'ORGANISATION', scopeKey: smsIds.org, actorJti: 'sms-initial', subjectFingerprint: 'a'.repeat(64),
      requestedByUserId: smsIds.user, successUrlDigest: 'b'.repeat(64), cancelUrlDigest: 'c'.repeat(64),
      stripeCheckoutSessionId: 'cs_sms', stripeSubscriptionId: 'sub_sms', status: 'COMPLETE', leaseExpiresAt: end,
      completionWebhookEventId: 'sms-checkout-event', completedAt: now } });
    await tx.billingStripeWebhookEvent.create({ data: { id: 'sms-paid-event', accountId: smsIds.account,
      stripeEventId: 'evt_sms_paid', type: 'invoice.paid', apiVersion: '2026-06-24.dahlia', livemode: false,
      stripeCreatedAt: now, stripeObjectId: 'in_sms', stripeObjectStatus: 'paid', stripeCustomerId: 'cus_sms',
      stripeSubscriptionId: 'sub_sms', stripeSubscriptionItemId: 'si_sms', stripeInvoiceId: 'in_sms', amountMinor: 975n, currency: 'USD' } });
    await tx.billingRecurringAddonSubscription.create({ data: { id: 'sms-subscription', accountId: smsIds.account,
      checkoutId: checkout.id, customerId: customer.id, catalogId: catalog.id, serviceId: smsIds.service,
      offerId: offer.id, offerKey: offer.key, orgId: smsIds.org, scope: 'ORGANISATION', scopeKey: smsIds.org,
      stripeSubscriptionId: 'sub_sms', stripeItemId: 'si_sms', status: 'active', currentPeriodStart: now,
      currentPeriodEnd: end, initialInvoicePaidAt: now, initialInvoiceId: 'in_sms', activationWebhookEventId: 'sms-paid-event',
      entitlementActivatedAt: now, livemode: false } });
  });
  await prisma.billingSmsNumberResource.create({ data: { id: smsIds.number, serviceId: smsIds.service,
    appKeyId: smsIds.lifecycle, orgId: smsIds.org, quoteId: monthly.id, offerId: offer.id,
    phoneNumber: smsPhone, country: 'CZ', accountSid: smsAccount, phoneNumberSid: `PN${'a'.repeat(32)}`, state: 'active' } });
  const metadata = recurringAddonMetadata(checkout, { id: smsIds.account, stripeAccountId: 'acct_sms_fixture', livemode: false });
  const remote = { id: 'sub_sms', customer: 'cus_sms', livemode: false, status: 'active', cancel_at_period_end: false,
    metadata, latest_invoice: 'in_sms', discounts: [], items: { data: [{ id: 'si_sms', quantity: 1, discounts: [],
      current_period_start: Math.floor(now.getTime() / 1000), current_period_end: Math.floor(end.getTime() / 1000),
      price: { id: 'price_sms', recurring: { interval: 'month', usage_type: 'licensed' } } }] } };
  const invoice = { id: 'in_sms', customer: 'cus_sms', livemode: false, status: 'paid', billing_reason: 'subscription_create',
    collection_method: 'charge_automatically', amount_due: 975, amount_paid: 975, amount_remaining: 0,
    subtotal: 975, total: 975, currency: 'usd', starting_balance: 0, amount_shipping: 0,
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, discounts: [], default_tax_rates: [],
    lines: { has_more: false, data: [{ amount: 975, subtotal: 975, currency: 'usd', quantity: 1, discounts: [],
      parent: { type: 'subscription_item_details', subscription_item_details: {
        proration: false, subscription: 'sub_sms', subscription_item: 'si_sms' } },
      pricing: { price_details: { price: 'price_sms' }, unit_amount_decimal: '975' } }] } };
  const cash = { available: true };
  const stripe = { accounts: { retrieveCurrent: async () => ({ id: 'acct_sms_fixture' }) },
    subscriptions: { retrieve: async () => remote, cancel: async () => { remote.status = 'canceled'; return remote; } },
    invoices: { retrieve: async () => invoice }, invoicePayments: { list: async () => ({ has_more: false,
      data: cash.available ? [{ id: 'ip_sms', invoice: 'in_sms', status: 'paid', currency: 'usd', livemode: false,
        amount_paid: 975, status_transitions: { paid_at: Math.floor(now.getTime() / 1000) },
        payment: { type: 'payment_intent', payment_intent: 'pi_sms' } }] : [] }) },
    paymentIntents: { retrieve: async () => ({ id: 'pi_sms', status: 'succeeded', customer: 'cus_sms',
      currency: 'usd', amount_received: 975, latest_charge: 'ch_sms', livemode: false }) },
    charges: { retrieve: async () => ({ id: 'ch_sms', payment_intent: 'pi_sms', customer: 'cus_sms', currency: 'usd',
      status: 'succeeded', paid: true, captured: true, amount_captured: 975, livemode: false }) },
  } as unknown as Stripe;
  let amount: string | null = '0.01';
  let created = new Date();
  let owned = true;
  const provider = new BillingSmsProvider({ accountSid: smsAccount, apiKeySid: `SK${'b'.repeat(32)}`,
    apiKeySecret: 'synthetic-unused-secret' }, async (url) => {
    const address = String(url);
    if (address.includes('pricing.twilio.com')) return new Response(JSON.stringify({ country: 'Czech Republic',
      iso_country: 'CZ', price_unit: 'usd', inbound_sms_prices: [{ number_type: 'mobile', current_price: '0.01' }],
      outbound_sms_prices: [{ carrier: 'Synthetic carrier', mcc: '230', mnc: '01',
        prices: [{ number_type: 'mobile', current_price: '0.01' }] }] }));
    if (address.includes('/PhoneNumbers/')) return new Response(JSON.stringify({
      country_code: 'CZ', valid: true, phone_number: decodeURIComponent(new URL(address).pathname.split('/').at(-1)!),
    }));
    if (address.includes('/IncomingPhoneNumbers/')) return new Response(JSON.stringify(owned ? {
      sid: `PN${'a'.repeat(32)}`, account_sid: smsAccount, phone_number: smsPhone, capabilities: { sms: true },
    } : { code: 20404 }), { status: owned ? 200 : 404 });
    const sid = /Messages\/(SM[\da-f]+)\.json/.exec(address)?.[1];
    return new Response(JSON.stringify({ sid, account_sid: smsAccount, from: smsPhone, to: '+420777000002',
      direction: 'outbound-api', status: 'sent', price: amount === null ? null : `-${amount}`,
      price_unit: amount === null ? null : 'usd', num_segments: '1', date_created: created.toUTCString() }));
  });
  async function actor(endpoint: string) {
    const issued = Math.floor(Date.now() / 1000);
    return new SignJWT({ product: 'nessie', organisation_id: smsIds.org, team_id: smsIds.team, tv: 0 })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic' }).setIssuer(lifecycle.actorIssuer)
      .setSubject(smsIds.user).setAudience(`${getPublicBaseUrl()}${endpoint}`).setIssuedAt(issued)
      .setExpirationTime(issued + 60).setJti(`sms-${endpoint}-${randomUUID()}`).sign(pair.privateKey);
  }
  return { lifecycle, entitlement, monthly, outbound, stripe, provider, actor, cash, remote, invoice,
    setReceipt(value: string | null, at = new Date()) { amount = value; created = at; },
    setOwned(value: boolean) { owned = value; } };
}
