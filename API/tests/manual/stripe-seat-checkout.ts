import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../helpers/test-db.js';
import { payload as exampleTerms } from '../unit/billing-stripe-checkout.test-fixtures.js';
import { sandboxCliClient } from './stripe-cli-sandbox.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { assignNewNessieOrganisation } from '../../src/services/billing-nessie-onboarding.service.js';
import { createStripeCheckoutSession } from '../../src/services/billing-stripe-checkout.service.js';
import { syncBaseStripeSubscription } from '../../src/services/billing-stripe-subscription-projection.service.js';
import { runAnniversarySeatCycle } from '../../src/services/billing-anniversary-seat-scheduler.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';

const [expected, optIn] = process.argv.slice(2);
assert.equal(optIn, '--create-test-data');
const stripe = sandboxCliClient(expected ?? '');
const requireAdmin = createRequire(new URL('../../../Admin/package.json', import.meta.url));
const { chromium } = requireAdmin('@playwright/test') as typeof import('@playwright/test');

async function pay(url: string) {
  assert.equal(new URL(url).hostname, 'checkout.stripe.com');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ locale: 'en-GB' }); page.setDefaultTimeout(45000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#cardNumber').fill('4242424242424242');
    await page.locator('#cardExpiry').fill('1235'); await page.locator('#cardCvc').fill('123');
    await page.locator('#billingName').fill('Nessie Sandbox Evaluation');
    await page.locator('#billingCountry').selectOption('GB');
    await page.getByRole('button', { name: 'Enter address manually' }).click();
    await page.locator('#billingAddressLine1').fill('1 Payment Test Road');
    await page.locator('#billingLocality').fill('London'); await page.locator('#billingPostalCode').fill('SW1A 1AA');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('https://example.com/?seat-evaluation=success', { timeout: 90000, waitUntil: 'commit' });
  } finally { await browser.close(); }
}

async function run() {
  const db = await createTestDb(); if (!db) throw new Error('An evaluation database is required');
  const p = db.prisma;
  const runId = 'nessie-seat-' + randomUUID();
  let clockId: string | undefined; let serviceId: string | undefined;
  try {
    const service = await p.billingService.create({ data: { identifier: 'nessie', name: 'Nessie seat evaluation' } });
    serviceId = service.id;
    const tariff = await createBillingTariffVersion({ serviceId, setAsDefault: false, actor: { email: 'eval@example.test' },
      tariff: { key: 'standard-eur', name: 'EUR seats', currency: 'EUR', monthlyAmountMinor: '299', mode: 'standard',
        collectionMode: 'stripe', monthlyChargeBasis: 'per_seat', seatPolicy: 'automatic', seatChargeTiming: 'prorated', usagePaymentMode: 'prepaid' } }, { prisma: p });
    const founder = await p.user.create({ data: { userKey: 'founder', email: 'nessie-billing-eval@example.com' } });
    const org = await p.organisation.create({ data: { domain: 'seat.example', name: 'Nessie evaluation', slug: 'seat-evaluation', ownerId: founder.id } });
    const team = await p.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    await p.orgMember.create({ data: { orgId: org.id, userId: founder.id, role: 'owner' } });
    const key = await p.billingAppKey.create({ data: { serviceId, name: 'Evaluation', purpose: 'CUSTOMER_LIFECYCLE', keyPrefix: 'uoa_eval',
      secretDigest: 'fixture-only', actorIssuer: 'https://seat.example', actorAudience: 'https://identity.example',
      actorKeyId: 'fixture', actorPublicJwk: {}, checkoutReturnOrigins: ['https://example.com'] } });
    await p.$transaction(tx => assignNewNessieOrganisation(tx, { serviceId: service.id, orgId: org.id,
      userId: founder.id, issuer: key.actorIssuer, currency: 'EUR', now: new Date() }));
    const assignment = await p.billingTariffAssignment.findFirstOrThrow({ where: { orgId: org.id } });
    const account = await p.billingStripeAccount.create({ data: { stripeAccountId: expected, livemode: false } });
    const epoch = Math.floor(Date.now()/1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: epoch - 14 * 86400, name: runId });
    clockId = clock.id;
    const customer = await stripe.customers.create({ name: 'Nessie evaluation', email: founder.email, test_clock: clock.id,
      metadata: { verification_run: runId, uoa_scope: 'organisation', uoa_scope_key: org.id, uoa_organisation_id: org.id,
        uoa_stripe_account_id: account.stripeAccountId, uoa_stripe_mode: 'test' } });
    await p.billingStripeCustomer.create({ data: { accountId: account.id, orgId: org.id, scope: 'ORGANISATION', scopeKey: org.id,
      stripeCustomerId: customer.id } });
    const request = { product: 'nessie', organisationId: org.id, teamId: team.id, userId: founder.id,
      successUrl: 'https://example.com/?seat-evaluation=success', cancelUrl: 'https://example.com/?seat-evaluation=cancel' };
    const terms = { ...exampleTerms, product: service, subject: { user_id: founder.id, organisation_id: org.id, team_id: team.id },
      authorized_party: { app_key_id: key.id }, assignment: { scope: 'organisation', id: assignment.id },
      tariff: { ...exampleTerms.tariff, id: tariff.id, key: tariff.key, version: tariff.version, monthly_subscription: {
        amount_minor: '299', currency: 'EUR', charge_basis: 'per_seat', seat_policy: 'automatic', seat_charge_timing: 'prorated' } } };
    // Only the incoming product actor is a fixture. Customer, Checkout, roster, invoices and card payments are real sandbox operations.
    const checkout = await createStripeCheckoutSession({ request, actorToken: 'evaluation', credential: { ...key, service } as never,
      endpoint: '/billing/v1/stripe/checkout' as never }, { prisma: p, stripe, stripeLivemode: false,
      resolveTariff: (async () => ({ actor: { jti: runId }, payload: terms })) as never,
      authorizeAction: (async () => ({ id: runId })) as never });
    console.log(JSON.stringify({ step: 'checkout_created', account: expected, session: checkout.checkout_session_id }));
    await pay(checkout.checkout_url);
    const session = await stripe.checkout.sessions.retrieve(checkout.checkout_session_id);
    assert.equal(session.payment_status, 'paid'); assert.equal(session.amount_total, 299);
    assert.equal(typeof session.subscription, 'string');
    const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
    assert.ok(subscription.default_payment_method); assert.equal(subscription.billing_mode.type, 'classic');
    await p.$transaction(tx => syncBaseStripeSubscription(tx, subscription, account));
    const record = async (invoiceId: string) => {
      const source = await prepareStripePaymentInvoice(invoiceId, account, p, stripe); assert.ok(source);
      await p.$transaction(tx => persistStripePaymentInvoice(tx, source)); await p.$transaction(tx => persistStripePaymentInvoice(tx, source));
      return source.facts.paidAmountMinor;
    };
    assert.equal(await record(subscription.latest_invoice as string), 299n);
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: Math.floor(Date.now()/1000) + 60 });
    for (let tries = 0; (await stripe.testHelpers.testClocks.retrieve(clock.id)).status !== 'ready'; tries++) {
      assert.ok(tries < 90); await wait(1000);
    }
    const member = await p.user.create({ data: { userKey: 'member', email: 'member@example.test' } });
    const invitation = await p.teamInvite.create({ data: { orgId: org.id, teamId: team.id, email: 'member@example.test', lastSentAt: new Date() } });
    assert.equal(await p.billingAutomaticSeatChange.count(), 0);
    await p.$transaction(async tx => {
      await tx.orgMember.create({ data: { orgId: org.id, userId: member.id, role: 'member' } });
      await tx.teamMember.create({ data: { userId: member.id, teamId: team.id } });
      await tx.teamInvite.update({ where: { id: invitation.id }, data: { acceptedUserId: member.id, acceptedAt: new Date() } });
    });
    const cycle = () => runAnniversarySeatCycle({ prisma: p, stripe, livemode: false });
    await cycle();
    const added = await p.billingAutomaticSeatChange.findFirstOrThrow();
    assert.ok(added.completedAt && added.stripeInvoiceId, 'Seat addition: ' + added.failureCode);
    const charge = await record(added.stripeInvoiceId); assert.ok(charge > 0n && charge < 299n);
    const identity = { orgId_userId: { orgId: org.id, userId: member.id } };
    await p.orgMember.update({ where: identity, data: { status: 'REMOVED' } }); await cycle();
    const removed = await p.billingAutomaticSeatChange.findFirstOrThrow({ where: { delta: -1 } });
    assert.ok(removed.completedAt); assert.equal(removed.stripeInvoiceId, null);
    const current = await stripe.subscriptions.retrieve(subscription.id);
    assert.equal(current.latest_invoice, added.stripeInvoiceId);
    assert.equal(current.items.data.find(item => item.price.recurring?.usage_type === 'licensed')?.quantity, 1);
    console.log(JSON.stringify({ step: 'verified', founderMinor: 299, additionMinor: charge.toString(), subscription: subscription.id,
      noCreditOnRemoval: true, renewalQuantity: 1, databaseCashInvoices: await p.billingStripePaymentInvoice.count() }));
  } finally {
    try {
      if (clockId) await stripe.testHelpers.testClocks.del(clockId);
      if (serviceId) {
        const catalogs = await p.billingStripeCatalog.findMany({ where: { serviceId }, include: { tariffPrices: true } });
        for (const catalog of catalogs) {
          for (const id of [catalog.stripeUsagePriceId, ...catalog.tariffPrices.map(row => row.stripeMonthlyPriceId)]) if (id) await stripe.prices.update(id, { active: false });
          if (catalog.stripeProductId) await stripe.products.update(catalog.stripeProductId, { active: false });
          if (catalog.stripeMeterId) await stripe.billing.meters.deactivate(catalog.stripeMeterId);
        }
      }
    } finally { await db.cleanup(); }
  }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; });

