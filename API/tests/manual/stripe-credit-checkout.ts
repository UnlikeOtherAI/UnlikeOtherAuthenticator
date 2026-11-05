import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type Stripe from 'stripe';
import { createTestDb } from '../helpers/test-db.js';
import { sandboxCliClient } from './stripe-cli-sandbox.js';
import { paySandboxCheckout } from './stripe-checkout-browser.js';
import { createBillingCreditTopUpCheckout } from '../../src/services/billing-credit-top-up.service.js';
import { provisionNessieTopUps } from '../../src/services/billing-nessie-top-up-catalog.service.js';
import { applyTrustedCreditFundingStripeEvent } from '../../src/services/billing-stripe-webhook-event.service.js';
import { CREDIT_PRODUCT_METADATA, CREDIT_TOP_UP_SPECS, creditPriceMetadata,
  creditFundingPolicySpec, type CreditPurchaseCurrency } from '../../src/services/billing-stripe-catalog-provisioning-spec.js';

const [expected, optIn, ...regions] = process.argv.slice(2);
assert.equal(optIn, '--create-test-data');
assert.ok(regions.length && regions.every(code => ['USD', 'EUR', 'GBP'].includes(code)));
const stripe = sandboxCliClient(expected ?? '');
const trace = 'nessie-credit-' + randomUUID();

async function catalogBasis() {
  const spec = CREDIT_TOP_UP_SPECS.find(s => s.key === 'credits_usd_10')!;
  const page = await stripe.prices.list({ lookup_keys: [spec.stripeLookupKey], limit: 2 });
  assert.ok(!page.has_more && page.data.length <= 1);
  let price = page.data[0];
  if (!price) {
    const product = await stripe.products.create({ name: 'UOA team credits (sandbox)', metadata: CREDIT_PRODUCT_METADATA },
      { idempotencyKey: 'uoa-sandbox-verification-credits-v1' });
    price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: Number(spec.paymentAmountMinor),
      lookup_key: spec.stripeLookupKey, metadata: creditPriceMetadata(spec) }, { idempotencyKey: 'uoa-sandbox-credits-basis-' + product.id });
  }
  assert.equal(typeof price.product, 'string');
  return { key: spec.catalogKey, version: spec.version, currency: spec.currency, paymentAmountMinor: spec.paymentAmountMinor,
    creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits, stripeLookupKey: spec.stripeLookupKey,
    stripeProductId: price.product as string, stripePriceId: price.id };
}

async function originalEvent(intentId: string, since: number): Promise<Stripe.Event> {
  for (let attempt = 0; attempt < 12; attempt++) {
    for await (const event of stripe.events.list({ type: 'payment_intent.succeeded', created: { gte: since }, limit: 100 })) {
      if (event.data.object.id === intentId) return event;
    }
    await wait(1000);
  }
  throw new Error('Original payment event unavailable for ' + intentId);
}

async function run() {
  const db = await createTestDb();
  if (!db) throw new Error('A dedicated PostgreSQL evaluation database is required');
  const p = db.prisma;
  try {
    const account = await p.billingStripeAccount.create({ data: { stripeAccountId: expected!, livemode: false } });
    const service = await p.billingService.create({ data: { identifier: 'nessie', name: 'Nessie sandbox' } });
    const key = await p.billingAppKey.create({ data: { serviceId: service.id, name: 'Evaluation',
      purpose: 'CUSTOMER_LIFECYCLE', keyPrefix: 'uoa_eval', secretDigest: 'fixture-only',
      actorIssuer: 'https://seat.example', actorAudience: 'https://identity.example', actorKeyId: 'fixture',
      actorPublicJwk: {}, checkoutReturnOrigins: ['https://example.com'] } });
    for (const currency of ['USD', 'EUR', 'GBP'] as const) {
      await p.billingCreditFundingPolicy.create({ data: { serviceId: service.id, ...creditFundingPolicySpec(currency) } });
    }
    await p.billingCreditTopUpCatalog.create({ data: { accountId: account.id, ...await catalogBasis() } });
    await provisionNessieTopUps({ prisma: p, stripe, expectedStripeAccountId: expected!, expectedLivemode: false, dryRun: false });
    for (const currency of regions as CreditPurchaseCurrency[]) {
      const user = await p.user.create({ data: { userKey: currency, email: 'nessie-billing-eval@example.' + currency.toLowerCase() } });
      const org = await p.organisation.create({ data: { ownerId: user.id, name: currency, slug: currency.toLowerCase(), domain: 'seat.example' } });
      const team = await p.team.create({ data: { orgId: org.id, name: 'First', slug: 'first' } });
      await p.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
      await p.teamMember.create({ data: { userId: user.id, teamId: team.id, teamRole: 'owner' } });
      const region = { USD: 'US', GBP: 'UK', EUR: 'EUROPE' }[currency];
      await p.billingOrganisationRegion.create({ data: { orgId: org.id, setByUserId: user.id, region, currency } });
      const scopeKey = org.id + ':' + team.id;
      const remote = await stripe.customers.create({ email: 'nessie-billing-eval@example.com',
        name: 'Nessie sandbox ' + currency, metadata: { verification_run: trace,
          uoa_scope: 'team', uoa_scope_key: scopeKey, uoa_organisation_id: org.id, uoa_team_id: team.id,
          uoa_stripe_account_id: expected!, uoa_stripe_mode: 'test' } });
      const customer = await p.billingStripeCustomer.create({ data: { accountId: account.id, orgId: org.id,
        teamId: team.id, scope: 'TEAM', scopeKey, stripeCustomerId: remote.id } });
      const wallet = await p.billingCreditAccount.create({ data: { accountId: account.id, customerId: customer.id,
        scopeKey, orgId: org.id, teamId: team.id } });
      for (const amount of [5, 10, 20, 100, 500]) {
        const since = Math.floor(Date.now() / 1000) - 60;
        const offer = await p.billingCreditTopUpOffer.findFirstOrThrow({ where: { serviceId: service.id,
          key: 'credits_' + currency.toLowerCase() + '_' + amount, manualPurchaseEnabled: true } });
        const balance = () => p.billingCreditAccount.findUniqueOrThrow({ where: { id: wallet.id } });
        const before = await balance();
        const checkout = await createBillingCreditTopUpCheckout({ actorToken: 'evaluation', credential: { ...key, service } as never,
          endpoint: '/billing/v1/credits/top-up-checkout', includePurchaseId: true, request: { organisationId: org.id,
            teamId: team.id, userId: user.id, product: 'nessie', offerId: offer.id } }, { prisma: p,
          resolveContext: (async () => ({ actor: { jti: randomUUID() }, account, creditAccount: before, customer, stripe,
            authorizeAction: async () => {}, ensureCustomer: async () => customer })) as never });
        const id = checkout.purchase_id!;
        const purchase = await p.billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id } });
        assert.equal((await balance()).balanceMicrocredits, before.balanceMicrocredits);
        assert.equal(await p.billingCreditPaymentInvoice.count({ where: { topUpCheckoutId: id } }), 0);
        await paySandboxCheckout(checkout.redirect_url, 'https://example.com/?uoa_billing=checkout_complete');
        const session = await stripe.checkout.sessions.retrieve(purchase.stripeCheckoutSessionId!);
        assert.equal(session.amount_total, amount * 100); assert.equal(session.currency, currency.toLowerCase());
        assert.equal(session.payment_status, 'paid'); assert.equal(typeof session.payment_intent, 'string');
        const intent = await stripe.paymentIntents.retrieve(session.payment_intent as string);
        assert.equal(intent.setup_future_usage, 'off_session');
        assert.equal((await stripe.paymentMethods.retrieve(intent.payment_method as string)).customer, remote.id);
        const event = await originalEvent(intent.id, since);
        const apply = () => applyTrustedCreditFundingStripeEvent({ event, expectedPaymentIntentId: intent.id, stripe, account, prisma: p });
        assert.deepEqual(await apply(), { applied: true, duplicate: false });
        assert.deepEqual(await apply(), { applied: false, duplicate: true });
        const invoice = await p.billingCreditPaymentInvoice.findFirstOrThrow({ where: { topUpCheckoutId: id } });
        assert.equal(invoice.currency, currency); assert.equal(invoice.grossAmountMinor, BigInt(amount * 100));
        assert.equal(invoice.stripePaymentIntentId, intent.id);
        assert.equal(invoice.creditsPurchasedMicrocredits, purchase.creditsReceivedMicrocredits);
        assert.equal(await p.billingCreditEntry.count({ where: { sourceType: 'credit_top_up_checkout', sourceId: id } }), 1);
        const after = await balance(); assert.equal(after.autoTopUpConsentRevisionId, null);
        assert.equal(after.balanceMicrocredits - before.balanceMicrocredits, purchase.creditsReceivedMicrocredits);
        console.log(JSON.stringify({ currency, amount, intent: intent.id, event: event.id, invoice: invoice.id,
          microcredits: purchase.creditsReceivedMicrocredits.toString(), fx: purchase.fxRateSource, savedCard: true, replay: 'duplicate' }));
      }
    }
  } catch (error) {
    console.error('Retained isolated PostgreSQL schema for recovery: ' + db.schema);
    await p.$disconnect();
    throw error;
  }
  await db.cleanup();
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Credit purchase evaluation failed'); process.exitCode = 1; });

