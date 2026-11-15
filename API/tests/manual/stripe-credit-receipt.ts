import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/test-db.js';
import { sandboxCliClient } from './stripe-cli-sandbox.js';
import { applyTrustedCreditFundingStripeEvent } from '../../src/services/billing-stripe-webhook-event.service.js';
import { validateCreditPrice } from '../../src/services/billing-stripe-catalog-provisioning-remote.service.js';
import { NESSIE_MANUAL_TOP_UP_SPECS } from '../../src/services/billing-stripe-catalog-provisioning-spec.js';

// Rebuild an isolated pre-payment fixture from the original tagged USD Checkout. No new provider writes.
const [expected, eventId] = process.argv.slice(2);
assert.match(eventId ?? '', /^evt_[a-zA-Z0-9]+$/);
const stripe = sandboxCliClient(expected ?? '');
async function run() {
  const event = await stripe.events.retrieve(eventId!);
  assert.equal(event.type, 'payment_intent.succeeded');
  if (event.type !== 'payment_intent.succeeded') throw new Error('Expected a successful payment');
  const intent = await stripe.paymentIntents.retrieve(event.data.object.id);
  const original = await stripe.customers.retrieve(intent.customer as string);
  assert.ok(!original.deleted && original.metadata.verification_run.startsWith('nessie-credit-'));
  const listing = await stripe.checkout.sessions.list({ payment_intent: intent.id, limit: 2 });
  assert.equal(listing.data.length, 1);
  const session = listing.data[0]!;
  const lines = await stripe.checkout.sessions.listLineItems(session.id);
  assert.equal(lines.data.length, 1);
  assert.equal(lines.data[0].quantity, 1);
  const price = await stripe.prices.retrieve(lines.data[0].price!.id);
  const product = await stripe.products.retrieve(price.product as string);
  assert.ok(!product.deleted);
  const spec = NESSIE_MANUAL_TOP_UP_SPECS.find(candidate => candidate.currency === 'USD' && candidate.stripeLookupKey === price.lookup_key);
  assert.ok(spec);
  const catalog = validateCreditPrice({ price, product, expectedLivemode: false, spec });
  assert.equal(session.payment_status, 'paid');
  assert.equal(intent.amount_received, Number(spec.paymentAmountMinor));
  const m = intent.metadata;
  const db = await createTestDb();
  assert.ok(db);
  const p = db.prisma;
  try {
    const account = await p.billingStripeAccount.create({ data: { stripeAccountId: expected!, livemode: false } });
    const service = await p.billingService.create({ data: { id: m.uoa_service_id, identifier: 'nessie', name: 'Receipt replay' } });
    const key = await p.billingAppKey.create({ data: { id: m.uoa_app_key_id, serviceId: service.id, name: 'Receipt replay',
      purpose: 'CUSTOMER_LIFECYCLE', keyPrefix: 'uoa_eval', secretDigest: 'fixture-only', actorIssuer: 'https://seat.example',
      actorAudience: 'https://identity.example', actorKeyId: 'fixture', actorPublicJwk: {}, checkoutReturnOrigins: ['https://example.com'] } });
    const owner = await p.user.create({ data: { userKey: 'replay', email: 'replay@example.test' } });
    const org = await p.organisation.create({ data: { id: original.metadata.uoa_organisation_id, ownerId: owner.id,
      name: 'Replay', slug: 'replay', domain: 'seat.example' } });
    const team = await p.team.create({ data: { id: original.metadata.uoa_team_id, orgId: org.id, name: 'First', slug: 'first' } });
    await p.orgMember.create({ data: { userId: owner.id, orgId: org.id, role: 'owner' } });
    await p.teamMember.create({ data: { userId: owner.id, teamId: team.id, teamRole: 'owner' } });
    const scopeKey = org.id + ':' + team.id;
    const customer = await p.billingStripeCustomer.create({ data: { accountId: account.id, orgId: org.id,
      teamId: team.id, scope: 'TEAM', scopeKey, stripeCustomerId: original.id } });
    const wallet = await p.billingCreditAccount.create({ data: { id: m.uoa_credit_account_id, accountId: account.id,
      customerId: customer.id, scopeKey, orgId: org.id, teamId: team.id } });
    const bound = await p.billingCreditTopUpCatalog.create({ data: { accountId: account.id, ...catalog, currency: spec.currency,
      paymentAmountMinor: spec.paymentAmountMinor, creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits } });
    const policy = await p.billingCreditFundingPolicy.create({ data: { serviceId: service.id, currency: spec.currency,
      version: 1, topUpEnabled: true, automaticTopUpEnabled: false, automaticConsentVersion: 'replay' } });
    const offer = await p.billingCreditTopUpOffer.create({ data: { serviceId: service.id, policyId: policy.id, key: spec.key,
      version: 1, catalogKey: spec.catalogKey, catalogVersion: 1, name: spec.name, description: spec.description,
      automaticTopUpEligible: false, paymentAmountMinor: spec.paymentAmountMinor, creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits } });
    const pending = await p.billingCreditTopUpCheckout.create({ data: { id: m.uoa_credit_top_up_checkout_id,
      accountId: account.id, creditAccountId: wallet.id, customerId: customer.id, catalogId: bound.id, serviceId: service.id,
      appKeyId: key.id, offerId: offer.id, actorJti: 'receipt-replay', requestedByUserId: owner.id,
      currency: spec.currency, paymentAmountMinor: spec.paymentAmountMinor, creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date() } });
    await p.billingCreditTopUpCheckout.update({ where: { id: pending.id }, data: { status: 'OPEN',
      stripeCheckoutSessionId: session.id, expiresAt: new Date(session.expires_at * 1000) } });
    const apply = () => applyTrustedCreditFundingStripeEvent({ event, expectedPaymentIntentId: intent.id, stripe, account, prisma: p });
    assert.deepEqual(await apply(), { applied: true, duplicate: false });
    assert.deepEqual(await apply(), { applied: false, duplicate: true });
    const after = await p.billingCreditAccount.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(after.balanceMicrocredits, spec.creditsReceivedMicrocredits);
    assert.equal(await p.billingCreditPaymentInvoice.count({ where: { topUpCheckoutId: pending.id } }), 1);
    console.log(JSON.stringify({ step: 'original_payment_replayed', event: event.id, apiVersion: event.api_version,
      intent: intent.id, amountMinor: intent.amount_received, currency: intent.currency, microcredits: after.balanceMicrocredits.toString(),
      cashInvoices: 1, repeatedDelivery: 'duplicate', localFixture: 'reconstructed' }));
  } finally { await db.cleanup(); }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Replay failed'); process.exitCode = 1; });
