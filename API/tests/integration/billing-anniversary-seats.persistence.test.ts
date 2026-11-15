import { readNessieSeatAccess } from '../../src/services/billing-nessie-seat-access.service.js';
import { recordSeatRenewalFailure } from '../../src/services/billing-seat-renewal.service.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAnniversarySeatCycle } from '../../src/services/billing-anniversary-seat-scheduler.service.js';
import { assignNewNessieOrganisation } from '../../src/services/billing-nessie-onboarding.service.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { syncBaseStripeSubscription } from '../../src/services/billing-stripe-subscription-projection.service.js';
import { persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { getActiveUserOrgContext } from '../../src/services/org-context.service.js';
import { createTestSandboxOrganisationPolicy } from '../helpers/organisation-financial-binding.js';
import { configureSyntheticStripeMode } from '../helpers/stripe-mode-config.js';
import { seatCashProvider } from '../helpers/seat-cash-provider.js';
import { createTestDb } from '../helpers/test-db.js';

type Db = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
describe.skipIf(!process.env.DATABASE_URL)('Nessie anniversary seat payments', () => {
  let db: Db;
  beforeAll(async () => { const created = await createTestDb(); if (!created) throw new Error('DATABASE_URL_REQUIRED'); db = created; });
  afterAll(async () => { if (db) await db.cleanup(); vi.unstubAllEnvs(); });

  it('holds invitations until collected, reuses a paid seat at acceptance and charges a new invitation after removal', async () => {
    const p = db.prisma;
    const user = (name: string) => p.user.create({ data: { email: name + '@example.test', userKey: name } });
    const founder = await user('seat-owner');
    const member = await user('seat-member');
    const service = await p.billingService.create({ data: { identifier: 'nessie', name: 'Nessie', tariffHistoryFromMonth: new Date().toISOString().slice(0, 7) } });
    const tariff = await createBillingTariffVersion({ serviceId: service.id, tariff: {
      key: 'standard-eur', name: 'EUR seats', currency: 'EUR', mode: 'standard', collectionMode: 'stripe',
      monthlyAmountMinor: '299', monthlyChargeBasis: 'per_seat', seatPolicy: 'automatic',
      seatChargeTiming: 'prorated', usagePaymentMode: 'prepaid',
    }, setAsDefault: false, actor: { email: 'operator@example.test' } }, { prisma: p });
    expect(tariff.anniversarySeats).toBe(true);
    const org = await p.organisation.create({ data: { name: 'Seat test', slug: 'seat-test', domain: 'seat.example', ownerId: founder.id } });
    const team = await p.team.create({ data: { orgId: org.id, name: 'One', slug: 'one' } });
    const orgMember = (userId: string) => p.orgMember.create({ data: { orgId: org.id, userId, role: userId === founder.id ? 'owner' : 'member' } });
    await orgMember(founder.id);
    const appKey = await p.billingAppKey.create({ data: { serviceId: service.id, purpose: 'CUSTOMER_LIFECYCLE', name: 'Seats',
      keyPrefix: 'uoa_test_seat', secretDigest: 'scope-test-digest', actorIssuer: 'https://seat.example',
      actorAudience: 'https://identity.example', actorKeyId: 'test', actorPublicJwk: {}, checkoutReturnOrigins: ['https://seat.example'] } });
    const enrollment = { serviceId: service.id, orgId: org.id, userId: founder.id,
      issuer: appKey.actorIssuer, currency: 'EUR', now: new Date() };
    await p.$transaction(tx => assignNewNessieOrganisation(tx, enrollment));
    await p.$transaction(tx => assignNewNessieOrganisation(tx, enrollment));
    expect(await p.billingTariffAssignment.count({ where: { orgId: org.id, tariffId: tariff.id } })).toBe(1);
    const invite = () => p.teamInvite.create({ data: { orgId: org.id, teamId: team.id,
      email: 'seat-member@example.test', lastSentAt: new Date() } });
    const held = await invite();
    const ready = async (id: string) => (await p.$queryRaw<Array<{ ready: boolean }>>`
      SELECT billing_invitation_seat_ready(${id}) AS ready`)[0]?.ready;
    expect(await ready(held.id)).toBe(false);
    expect((await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: org.id } })).endedAt).not.toBeNull();
    await p.teamInvite.update({ where: { id: held.id }, data: { revokedAt: new Date(), revokedReason: 'REVOKED' } });
    await expect(orgMember(member.id)).rejects.toThrow('complete the seat payment');
    const billingScopeEpoch = await createTestSandboxOrganisationPolicy(p, org.id);
    configureSyntheticStripeMode('acct_seat', false);
    const acct = await p.billingStripeAccount.create({ data: { stripeAccountId: 'acct_seat', livemode: false } });
    const customer = await p.billingStripeCustomer.create({ data: { accountId: acct.id, orgId: org.id, scope: 'ORGANISATION',
      scopeKey: org.id, stripeCustomerId: 'cus_seat' } });
    const catalog = await p.billingStripeCatalog.create({ data: { accountId: acct.id, serviceId: service.id, currency: 'EUR',
      meterEventName: 'seat_usage', stripeProductId: 'prod_seat', stripeMeterId: 'mtr_seat', stripeUsagePriceId: 'price_usage' } });
    await p.billingStripeTariffPrice.create({ data: { accountId: acct.id, catalogId: catalog.id, tariffId: tariff.id,
      monthlyAmountMinor: 299n, stripeMonthlyPriceId: 'price_seat' } });
    const assignment = await p.billingTariffAssignment.findFirstOrThrow({ where: { orgId: org.id, tariffId: tariff.id } });
    const checkout = await p.billingStripeCheckoutSession.create({ data: { accountId: acct.id, appKeyId: appKey.id,
      billingScopeEpoch, billingModeTeamId: team.id, billingModeRevision: 1,
      stripeCheckoutSessionId: 'cs_seat', tariffAssignmentId: assignment.id,
      customerId: customer.id, tariffId: tariff.id, serviceId: service.id, tariffSource: 'ORGANISATION', orgId: org.id,
      scope: 'ORGANISATION', scopeKey: org.id, actorJti: 'actor', requestedByUserId: founder.id, status: 'complete',
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date() } });
    expect(checkout.initialSeatMembers).toEqual([founder.id]);
    let now = new Date(Date.now() + 1000);
    const start = Math.floor(now.getTime() / 1000) - 60;
    const period = { current_period_start: start, current_period_end: start + 30 * 86400 };
    const item = { ...period, id: 'si_seat', quantity: 1, price: { id: 'price_seat', currency: 'eur', unit_amount: 299,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } };
    const remote = { id: 'sub_seat', customer: 'cus_seat', status: 'active', livemode: false,
      billing_mode: { type: 'classic' }, cancel_at_period_end: false,
      items: { data: [item, { ...period, id: 'si_usage', price: { id: 'price_usage', recurring: { usage_type: 'metered' } } }] },
      metadata: { uoa_checkout_id: checkout.id, uoa_service_id: service.id, uoa_tariff_id: tariff.id,
        uoa_scope_key: org.id, uoa_stripe_account_id: acct.stripeAccountId, uoa_stripe_mode: 'test' } };
    await p.$transaction(tx => syncBaseStripeSubscription(tx, remote as never, acct));
    await p.$transaction(tx => syncBaseStripeSubscription(tx, remote as never, acct));
    expect(await p.billingAutomaticSeatChange.count()).toBe(0);
    // Subscription status precedes the cash webhook. It must not admit anyone in that interval.
    const invitation = await invite();
    expect(await ready(invitation.id)).toBe(false);
    const initialSubscription = await p.billingStripeSubscription.findFirstOrThrow();
    await p.$transaction(tx => persistStripePaymentInvoice(tx, {
      facts: { accountId: acct.id, subscriptionId: initialSubscription.id, livemode: false,
        stripeInvoiceId: 'in_initial', stripeCustomerId: 'cus_seat', stripePaymentIntentIds: ['pi_initial'],
        paymentEvidence: [{ invoice_payment_id: 'inpay_initial', payment_intent_id: 'pi_initial',
          charge_id: 'ch_initial', amount_minor: '299', paid_at: now.toISOString() }],
        orgId: org.id, teamId: null, paidAt: now, currency: 'EUR', grossAmountMinor: 299n,
        taxAmountMinor: 0n, creditAmountMinor: 0n, dueAmountMinor: 299n, paidAmountMinor: 299n },
      lines: [{ stripeLineId: 'il_initial', serviceId: service.id, serviceIdentifier: 'nessie',
        billingMonth: new Date(start * 1000).toISOString().slice(0, 7), label: 'Seat subscription',
        subscriptionMinor: 299n, usageMinor: 0n, taxMinor: 0n, creditMinor: 0n, grossMinor: 299n, dueMinor: 299n,
        seatPeriod: { subscriptionId: initialSubscription.id, startsAt: new Date(start * 1000),
          endsAt: new Date(period.current_period_end * 1000), quantity: 1 } }], sourceDigest: 'c'.repeat(64), invoice: { billing_reason: 'subscription_create', status: 'paid',
        total: 299, amount_due: 299, amount_paid: 299, amount_remaining: 0, ending_balance: 0 },
    } as never));
    expect((await p.billingStripeSubscription.findFirstOrThrow()).initialSeatInvoiceId).not.toBeNull();
    // Collection is queued when the first receipt arrives, even if the invitation arrived before its webhook.
    expect(await p.billingAutomaticSeatChange.count()).toBe(1);
    await expect(orgMember(member.id)).rejects.toThrow('complete the seat payment');
    const accept = (id: string, userId: string) => p.$transaction(async tx => {
      await tx.orgMember.upsert({ where: { orgId_userId: { orgId: org.id, userId } },
        create: { orgId: org.id, userId, role: 'member' }, update: { status: 'ACTIVE' } });
      await tx.teamMember.upsert({ where: { teamId_userId: { teamId: team.id, userId } },
        create: { teamId: team.id, userId }, update: { status: 'ACTIVE' } });
      await tx.teamInvite.update({ where: { id }, data: { acceptedAt: new Date(), acceptedUserId: userId } });
    });
    const context = () => getActiveUserOrgContext({ userId: member.id, orgId: org.id, domain: org.domain }, { prisma: p });
    let pending = true;
    const invoices = new Map<string, { id: string; status: string; livemode: boolean; currency: string; customer: string;
      total: number; amount_due: number; amount_paid: number; amount_remaining: number; ending_balance: number;
      billing_reason: string; parent: { subscription_details: { subscription: string } } }>();
    const update = vi.fn(async (_id, params) => {
      if (params.proration_behavior === 'none') { item.quantity = params.items[0].quantity; return remote; }
      const invoice = { id: 'in_' + (invoices.size + 1), status: pending ? 'open' : 'paid', livemode: false,
        total: 299, amount_due: 299, amount_paid: 299, amount_remaining: 0, ending_balance: 0,
        currency: 'eur', customer: 'cus_seat', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: remote.id } } };
      invoices.set(invoice.id, invoice);
      if (!pending) item.quantity = params.items[0].quantity;
      return { ...remote, latest_invoice: invoice, pending_update: pending ? {} : null };
    });
    const stripe = { ...seatCashProvider(id => invoices.get(id)!), subscriptions: { retrieve: async () => remote, update }, invoices: { retrieve: async (id: string) => invoices.get(id) },
      accounts: { retrieveCurrent: async () => ({ id: acct.stripeAccountId }) } };
    const cycle = () => runAnniversarySeatCycle({ prisma: p, stripe: stripe as never, livemode: false, now: () => now });
    await Promise.all([cycle(), cycle()]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await p.billingAutomaticSeatChange.findFirst()).toMatchObject({ delta: 1, fromQuantity: 1, toQuantity: 2,
      completedAt: null, stripeInvoiceId: 'in_1', failureCode: 'PAYMENT_REQUIRED' });
    expect(await context()).toBeNull();
    expect(await ready(invitation.id)).toBe(false);
    await expect(accept(invitation.id, member.id)).rejects.toThrow('complete the seat payment');
    const first = invoices.get('in_1'); if (!first) throw new Error('Missing seat invoice');
    pending = false; first.status = 'paid'; item.quantity = 2; now = new Date(now.getTime() + 61000);
    await cycle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(await ready(invitation.id)).toBe(true);
    await p.teamInvite.update({ where: { id: invitation.id }, data: { revokedAt: new Date(), revokedReason: 'REPLACED' } });
    const resent = await invite();
    expect(resent.billingSeatSourceInviteId).toBe(invitation.id);
    expect(await ready(resent.id)).toBe(true);
    await accept(resent.id, member.id);
    expect(await p.billingAutomaticSeatChange.count()).toBe(1);
    expect((await context())?.teams).toContain(team.id);
    const identity = { orgId_userId: { orgId: org.id, userId: member.id } };
    remote.status = 'past_due';
    await p.$transaction(tx => syncBaseStripeSubscription(tx, remote as never, acct));
    await p.orgMember.update({ where: identity, data: { status: 'REMOVED' } });
    update.mockRejectedValueOnce(new Error('Temporary provider outage'));
    await cycle();
    const delayed = await p.billingAutomaticSeatChange.findFirstOrThrow({ where: { delta: -1 } });
    expect(delayed).toMatchObject({ completedAt: null, failureCode: 'PROVIDER_RETRY' });
    expect(item.quantity).toBe(2);
    now = new Date(now.getTime() + 24 * 3600_000);
    await cycle();
    expect(item.quantity).toBe(1);
    expect((await p.billingAutomaticSeatChange.findUniqueOrThrow({ where: { id: delayed.id } })).firstAttemptAt)
      .toEqual(delayed.firstAttemptAt);
    expect(await context()).toBeNull();
    remote.status = 'active';
    await p.$transaction(tx => syncBaseStripeSubscription(tx, remote as never, acct));
    await expect(p.orgMember.update({ where: identity, data: { status: 'ACTIVE' } })).rejects.toThrow('complete the seat payment');
    const returning = await invite();
    expect(await ready(returning.id)).toBe(false);
    await cycle(); await cycle();
    await accept(returning.id, member.id);
    const evidence = await p.billingAutomaticSeatChange.findMany({ orderBy: { id: 'asc' } });
    expect(evidence.map(row => [row.delta, row.fromQuantity, row.toQuantity, row.stripeInvoiceId])).toEqual([
      [1, 1, 2, 'in_1'], [-1, 2, 1, null], [1, 1, 2, 'in_2'],
    ]);
    expect(evidence.every(row => row.completedAt)).toBe(true);
    expect(update.mock.calls.map(call => call[1].proration_behavior)).toEqual(['always_invoice', 'none', 'none', 'always_invoice']);
    expect(invoices.size).toBe(2);
    await expect(p.billingAutomaticSeatChange.delete({ where: { id: evidence[0].id } })).rejects.toThrow('immutable');
    const additional = await Promise.all([user('concurrent-one'), user('concurrent-two')]);
    const sent = await Promise.all(additional.map(person => p.teamInvite.create({ data: {
      orgId: org.id, teamId: team.id, email: person.email!, lastSentAt: now,
    } })));
    expect(await Promise.all(sent.map(row => ready(row.id)))).toEqual([false, false]);
    await Promise.all([cycle(), cycle()]);
    const joined = await p.billingAutomaticSeatChange.findMany({ where: { inviteId: { in: sent.map(row => row.id) } },
      orderBy: { id: 'asc' } });
    expect(joined.map(row => [row.fromQuantity, row.toQuantity])).toEqual([[2, 3], [3, 4]]);
    expect(joined.every(row => row.completedAt && row.stripeInvoiceId)).toBe(true);
    expect(new Set(joined.map(row => row.stripeInvoiceId)).size).toBe(2);
    await Promise.all(sent.map((row, index) => accept(row.id, additional[index].id)));
    expect(await p.billingAutomaticSeatChange.count()).toBe(5);
    await expect(p.billingAutomaticSeatChange.update({ where: { id: evidence[0].id },
      data: { completedAt: null } })).rejects.toThrow('immutable');
    await expect(p.billingAutomaticSeatChange.update({ where: { id: evidence[0].id },
      data: { userId: founder.id } })).rejects.toThrow('immutable');
    const cancelled = await p.teamInvite.create({ data: { orgId: org.id, teamId: team.id,
      email: 'cancel-before-provider@example.test', lastSentAt: now } });
    await p.teamInvite.update({ where: { id: cancelled.id }, data: { revokedAt: new Date(), revokedReason: 'REVOKED' } });
    const cancelledChanges = await p.billingAutomaticSeatChange.findMany({ where: { inviteId: cancelled.id }, orderBy: { id: 'asc' } });
    expect(cancelledChanges.map(row => [row.delta, row.cancelledWithoutCharge, row.stripeInvoiceId])).toEqual([
      [1, true, null], [-1, true, null],
    ]);
    expect(cancelledChanges.every(row => row.completedAt)).toBe(true);
    expect(await ready(cancelled.id)).toBe(false);
    await cycle();
    expect(item.quantity).toBe(4);

    // A free-to-paid transition charges the frozen existing cohort plus the new invitation.
    const cohortOrg = await p.organisation.create({ data: { name: 'Existing cohort', slug: 'existing-cohort',
      domain: 'cohort.example', ownerId: founder.id } });
    const cohortTeam = await p.team.create({ data: { orgId: cohortOrg.id, name: 'Cohort', slug: 'cohort' } });
    await p.orgMember.createMany({ data: [{ orgId: cohortOrg.id, userId: founder.id, role: 'owner' },
      { orgId: cohortOrg.id, userId: member.id, role: 'member' }] });
    await p.billingAppKey.create({ data: { serviceId: service.id, purpose: appKey.purpose, name: 'Cohort key',
      keyPrefix: 'uoa_test_cohort', secretDigest: 'cohort-scope-test-digest', actorIssuer: 'https://cohort.example',
      actorAudience: appKey.actorAudience, actorKeyId: 'cohort', actorPublicJwk: {}, checkoutReturnOrigins: appKey.checkoutReturnOrigins } });
    await p.$transaction(tx => assignNewNessieOrganisation(tx, { ...enrollment, orgId: cohortOrg.id,
      issuer: 'https://cohort.example' }));
    await p.$executeRaw`SELECT billing_nessie_start_transition(${cohortOrg.id})`;
    const cohort = await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: cohortOrg.id } });
    expect(cohort.cohortUserIds).toEqual([founder.id, member.id].sort());
    expect(cohort.endsAt.getTime() - cohort.startsAt.getTime()).toBe(14 * 86400_000);
    await p.$executeRaw`SELECT billing_nessie_start_transition(${cohortOrg.id})`;
    expect(await p.billingNessieSeatTransition.findUnique({ where: { orgId: cohortOrg.id } })).toEqual(cohort);
    const extra = await p.teamInvite.create({ data: { orgId: cohortOrg.id, teamId: cohortTeam.id,
      email: 'cohort-addition@example.test', lastSentAt: now } });
    expect((await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: cohortOrg.id } })).endedAt).not.toBeNull();
    expect(await ready(extra.id)).toBe(false);
    const cohortEpoch = await createTestSandboxOrganisationPolicy(p, cohortOrg.id);
    const cohortCustomer = await p.billingStripeCustomer.create({ data: { accountId: acct.id, orgId: cohortOrg.id,
      scope: 'ORGANISATION', scopeKey: cohortOrg.id, stripeCustomerId: 'cus_cohort' } });
    const cohortAssignment = await p.billingTariffAssignment.findFirstOrThrow({ where: { orgId: cohortOrg.id, tariffId: tariff.id } });
    const cohortCheckout = await p.billingStripeCheckoutSession.create({ data: { accountId: acct.id, appKeyId: appKey.id,
      billingScopeEpoch: cohortEpoch, billingModeTeamId: cohortTeam.id, billingModeRevision: 1,
      tariffAssignmentId: cohortAssignment.id, customerId: cohortCustomer.id, tariffId: tariff.id, serviceId: service.id,
      tariffSource: 'ORGANISATION', orgId: cohortOrg.id, scope: 'ORGANISATION', scopeKey: cohortOrg.id,
      actorJti: 'cohort-actor', requestedByUserId: founder.id, status: 'creating',
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date() } });
    expect(cohortCheckout.initialSeatMembers).toEqual([founder.id, member.id].sort());
    expect(cohortCheckout.initialSeatInvites).toEqual([extra.id]);
    await expect(p.teamInvite.create({ data: { orgId: cohortOrg.id, teamId: cohortTeam.id,
      email: 'changed-quantity@example.test', lastSentAt: now } })).rejects.toThrow('open seat checkout');

    const seatScope = { serviceId: service.id, organisationId: org.id, teamId: team.id, userId: founder.id };
    const access = (at: Date) => p.$transaction(tx => readNessieSeatAccess(tx, seatScope, at));
    expect((await access(new Date(start * 1000))).status).toBe('paid');
    const renewalAt = new Date(period.current_period_end * 1000);
    expect((await access(renewalAt)).allowed).toBe(false);
    const deadline = new Date(renewalAt.getTime() + 86400_000);
    await p.$transaction(tx => recordSeatRenewalFailure(tx, { accountId: acct.id,
      subscriptionId: initialSubscription.id, stripeInvoiceId: 'in_renewal', failedAt: renewalAt,
      graceEndsAt: deadline, reason: 'payment_required' }));
    expect(await access(renewalAt)).toMatchObject({ allowed: true, status: 'renewal_grace', deadline: deadline.toISOString() });
    expect((await access(deadline)).allowed).toBe(false);
    await expect(p.billingSeatRenewalRecovery.updateMany({ where: { subscriptionId: initialSubscription.id },
      data: { graceEndsAt: new Date(deadline.getTime() + 1) } })).rejects.toThrow('immutable');
    await p.$transaction(tx => persistStripePaymentInvoice(tx, {
      facts: { accountId: acct.id, subscriptionId: initialSubscription.id, livemode: false,
        stripeInvoiceId: 'in_renewal', stripeCustomerId: 'cus_seat', stripePaymentIntentIds: ['pi_renewal'],
        paymentEvidence: [{ invoice_payment_id: 'inpay_renewal', payment_intent_id: 'pi_renewal',
          charge_id: 'ch_renewal', amount_minor: '1196', paid_at: deadline.toISOString() }],
        orgId: org.id, teamId: null, paidAt: deadline, currency: 'EUR', grossAmountMinor: 1196n,
        taxAmountMinor: 0n, creditAmountMinor: 0n, dueAmountMinor: 1196n, paidAmountMinor: 1196n },
      lines: [{ stripeLineId: 'il_renewal', serviceId: service.id, serviceIdentifier: 'nessie',
        billingMonth: renewalAt.toISOString().slice(0, 7), label: 'Seat subscription',
        subscriptionMinor: 1196n, usageMinor: 0n, taxMinor: 0n, creditMinor: 0n, grossMinor: 1196n, dueMinor: 1196n,
        seatPeriod: { subscriptionId: initialSubscription.id, startsAt: renewalAt,
          endsAt: new Date(renewalAt.getTime() + 30 * 86400_000), quantity: 4 } }], sourceDigest: 'd'.repeat(64),
      invoice: { billing_reason: 'subscription_cycle', status: 'paid', total: 1196, amount_due: 1196,
        amount_paid: 1196, amount_remaining: 0, ending_balance: 0 },
    } as never));
    expect((await access(deadline)).status).toBe('paid');
    const receipt = await p.billingStripePaymentInvoice.findFirstOrThrow({ where: { stripeInvoiceId: 'in_renewal' } });
    const adjustment = { invoiceId: receipt.id, stripePaymentIntentId: 'pi_renewal', stripeChargeId: 'ch_renewal',
      stripeObjectId: 'dp_renewal', amountMinor: 1196n, currency: 'EUR', occurredAt: deadline,
      evidenceDigest: 'e'.repeat(64), stripeEventId: 'evt_dispute' };
    await p.billingStripePaymentInvoiceAdjustment.create({ data: { ...adjustment, kind: 'DISPUTE' } });
    expect((await access(deadline)).allowed).toBe(false);
    await p.billingStripePaymentInvoiceAdjustment.create({ data: { ...adjustment, kind: 'DISPUTE_REVERSAL', stripeEventId: 'evt_won' } });
    expect((await access(deadline)).status).toBe('paid');
    await p.billingStripePaymentInvoiceAdjustment.create({ data: { ...adjustment, kind: 'REFUND',
      stripeObjectId: 're_renewal', amountMinor: 1n, stripeEventId: 'evt_refund' } });
    expect((await access(deadline)).allowed).toBe(false);

  });
});
