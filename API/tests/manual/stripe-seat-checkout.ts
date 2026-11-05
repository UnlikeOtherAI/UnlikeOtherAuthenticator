import assert from 'node:assert/strict';
import { paySandboxCheckout } from './stripe-checkout-browser.js';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { createOrganisation } from '../../src/services/organisation.service.organisation.js';
import { removeOrganisationMember } from '../../src/services/organisation.service.members.js';
import { getActiveUserOrgContext } from '../../src/services/org-context.service.js';
import { acceptTeamInviteWithinTransaction, createTeamInvites } from '../../src/services/team-invite.service.js';
import { payload as exampleTerms } from '../unit/billing-stripe-checkout.test-fixtures.js';
import { sandboxCliClient } from './stripe-cli-sandbox.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { setOrganisationBillingRegion } from '../../src/services/billing-organisation-region.service.js';
import { creditValueTarget } from '../../src/services/billing-credit-lot-value.service.js';
import { createStripeCheckoutSession } from '../../src/services/billing-stripe-checkout.service.js';
import { syncBaseStripeSubscription } from '../../src/services/billing-stripe-subscription-projection.service.js';
import { runAnniversarySeatCycle } from '../../src/services/billing-anniversary-seat-scheduler.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';

const [expected, optIn] = process.argv.slice(2);
assert.equal(optIn, '--create-test-data');
const stripe = sandboxCliClient(expected ?? '');
// This isolated process signs only its own test invitation, never a hosted session.
process.env.SHARED_SECRET = randomUUID() + randomUUID();
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
    const domain = 'seat.example';
    const config = validateConfigFields(baseClientConfigPayload({ domain, org_features: { enabled: true } }));
    const org = await createOrganisation({ domain, config, name: 'Nessie evaluation', slug: 'seat-evaluation',
      ownerId: founder.id, actorUserId: founder.id }, { prisma: p, auditPrisma: p });
    const team = await p.team.findFirstOrThrow({ where: { orgId: org.id, isDefault: true } });
    const key = await p.billingAppKey.create({ data: { serviceId, name: 'Evaluation', purpose: 'CUSTOMER_LIFECYCLE', keyPrefix: 'uoa_eval',
      secretDigest: 'fixture-only', actorIssuer: 'https://seat.example', actorAudience: 'https://identity.example',
      actorKeyId: 'fixture', actorPublicJwk: {}, checkoutReturnOrigins: ['https://example.com'] } });
    let messages = 0;
    const issueInvite = () => createTeamInvites({ domain, config, configUrl: 'https://seat.example/config',
      orgId: org.id, teamId: team.id, invitedBy: { userId: founder.id }, invites: [{ email: 'member@example.test' }] },
    { prisma: p, inviterPrisma: p, sendTeamInviteEmail: async mail => {
      assert.equal(mail.to, 'member@example.test'); messages++;
    } });
    await assert.rejects(issueInvite, /choose the billing region and complete the seat payment/i);
    const region = await setOrganisationBillingRegion({
      request: { product: 'nessie', organisationId: org.id, teamId: team.id, userId: founder.id },
      region: 'EUROPE', actorToken: 'evaluation', credential: { ...key, service } as never,
      endpoint: '/billing/v1/organisation-billing/region',
    }, { prisma: p, resolveTariff: (async () => ({ actor: { jti: runId } })) as never, authorizeAction: async () => {},
      captureRate: id => creditValueTarget(id, { db: p, stripe }) });
    assert.equal(region.currency, 'EUR');
    await assert.rejects(issueInvite, /billing manager must complete the seat payment/i);
    assert.equal(messages, 0); assert.equal(await p.teamInvite.count(), 0);
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
    await paySandboxCheckout(checkout.checkout_url, request.successUrl);
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
    const [issued] = (await issueInvite()).results;
    assert.ok(issued?.status === 'invited'); assert.equal(messages, 1);
    const invitation = issued.invite;
    const member = await p.user.create({ data: { userKey: 'member', email: issued.email } });
    assert.equal(await p.billingAutomaticSeatChange.count(), 0);
    const accept = () => p.$transaction(prisma => acceptTeamInviteWithinTransaction({
      teamInviteId: invitation.id, userId: member.id, prisma, config, now: new Date(),
    }));
    const access = () => getActiveUserOrgContext({ userId: member.id, orgId: org.id, domain }, { prisma: p });
    assert.deepEqual(await accept(), { orgId: org.id, teamId: team.id });
    assert.equal(await access(), null, 'An unpaid seat must not grant Nessie access');
    await accept();
    assert.equal(await p.billingAutomaticSeatChange.count(), 1, 'Reopening the invitation must not charge twice');
    async function settle(delta: number) {
      const deadline = Date.now() + 90_000;
      do {
        await runAnniversarySeatCycle({ prisma: p, stripe, livemode: false });
        const row = await p.billingAutomaticSeatChange.findFirstOrThrow({ where: { delta } });
        assert.equal(row.failureCode, null, 'Seat operation ' + delta + ': ' + row.failureCode);
        if (row.completedAt) return row;
        await wait(1000);
      } while (Date.now() < deadline);
      throw new Error('Seat scheduler did not settle operation ' + delta);
    }
    const added = await settle(1);
    assert.ok(added.stripeInvoiceId);
    const charge = await record(added.stripeInvoiceId); assert.ok(charge > 0n && charge < 299n);
    assert.ok((await access())?.teams.includes(team.id), 'Payment unlocks the accepted team');
    assert.deepEqual(await removeOrganisationMember({ domain, config, orgId: org.id,
      actorUserId: founder.id, userId: member.id }, { prisma: p }), { removed: true });
    assert.equal(await access(), null, 'Removal revokes access before Stripe updates the quantity');
    const removed = await settle(-1);
    assert.ok(removed.completedAt); assert.equal(removed.stripeInvoiceId, null);
    const current = await stripe.subscriptions.retrieve(subscription.id);
    assert.equal(current.latest_invoice, added.stripeInvoiceId);
    assert.equal(current.items.data.find(item => item.price.recurring?.usage_type === 'licensed')?.quantity, 1);
    console.log(JSON.stringify({ step: 'verified', founderMinor: 299, additionMinor: charge.toString(), subscription: subscription.id,
      founderCreatedDefaultTeam: team.isDefault, refusedBeforeRegionAndCard: true, invitationsDelivered: messages,
      replayedAcceptance: true, blockedUntilPaid: true, revokedOnRemoval: true,
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
