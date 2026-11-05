import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAnniversarySeatCycle } from '../../src/services/billing-anniversary-seat-scheduler.service.js';
import { assignNewNessieOrganisation } from '../../src/services/billing-nessie-onboarding.service.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { syncBaseStripeSubscription } from '../../src/services/billing-stripe-subscription-projection.service.js';
import { getActiveUserOrgContext } from '../../src/services/org-context.service.js';
import { createTestDb } from '../helpers/test-db.js';

type Db = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
describe.skipIf(!process.env.DATABASE_URL)('Nessie anniversary seat payments', () => {
  let db: Db;
  beforeAll(async () => { const created = await createTestDb(); if (!created) throw new Error('DATABASE_URL_REQUIRED'); db = created; });
  afterAll(async () => { if (db) await db.cleanup(); });

  it('collects the founder at signup, blocks unpaid access and preserves every join, departure and rejoin', async () => {
    const p = db.prisma;
    const user = (name: string) => p.user.create({ data: { email: name + '@example.test', userKey: name } });
    const founder = await user('seat-owner');
    const member = await user('seat-member');
    const service = await p.billingService.create({ data: { identifier: 'nessie', name: 'Nessie' } });
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
    await expect(invite()).rejects.toThrow('complete the seat payment');
    await expect(orgMember(member.id)).rejects.toThrow('complete the seat payment');
    const acct = await p.billingStripeAccount.create({ data: { stripeAccountId: 'acct_seat', livemode: false } });
    const customer = await p.billingStripeCustomer.create({ data: { accountId: acct.id, orgId: org.id, scope: 'ORGANISATION',
      scopeKey: org.id, stripeCustomerId: 'cus_seat' } });
    const catalog = await p.billingStripeCatalog.create({ data: { accountId: acct.id, serviceId: service.id, currency: 'EUR',
      meterEventName: 'seat_usage', stripeProductId: 'prod_seat', stripeMeterId: 'mtr_seat', stripeUsagePriceId: 'price_usage' } });
    await p.billingStripeTariffPrice.create({ data: { accountId: acct.id, catalogId: catalog.id, tariffId: tariff.id,
      monthlyAmountMinor: 299n, stripeMonthlyPriceId: 'price_seat' } });
    const assignment = await p.billingTariffAssignment.findFirstOrThrow({ where: { orgId: org.id, tariffId: tariff.id } });
    const checkout = await p.billingStripeCheckoutSession.create({ data: { accountId: acct.id, appKeyId: appKey.id,
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
    const invitation = await invite();
    expect(await p.billingAutomaticSeatChange.count()).toBe(0);
    await p.$transaction(async tx => {
      await tx.orgMember.create({ data: { orgId: org.id, userId: member.id, role: 'member' } });
      await tx.teamMember.create({ data: { teamId: team.id, userId: member.id } });
      await tx.teamInvite.update({ where: { id: invitation.id }, data: { acceptedAt: new Date(), acceptedUserId: member.id } });
    });
    const context = () => getActiveUserOrgContext({ userId: member.id, orgId: org.id, domain: org.domain }, { prisma: p });
    // Retain the actual migration's table revocations. Only schema usage is needed by the tenant role.
    await p.$executeRawUnsafe('GRANT USAGE ON SCHEMA "' + db.schema + '" TO uoa_app');
    const unpaid = (actor: string, subject: string, domain: string) => p.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
      await tx.$executeRaw`SELECT set_config('app.user_id',${actor},true),
        set_config('app.domain',${domain},true),set_config('app.org_id',${org.id},true)`;
      return tx.$queryRaw`SELECT team_id FROM billing_pending_product_seats(${org.id},${subject},${domain})`;
    });
    expect(await unpaid(member.id, member.id, org.domain)).toEqual([{ team_id: null }]);
    expect(await unpaid(founder.id, founder.id, org.domain)).toEqual([]);
    expect(await unpaid(member.id, founder.id, org.domain)).toEqual([{ team_id: null }]);
    expect(await unpaid(member.id, member.id, 'another-product.example')).toEqual([]);
    await expect(p.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
      return tx.billingAutomaticSeatChange.findMany();
    })).rejects.toThrow();
    expect(await context()).toBeNull();
    await p.billingService.update({ where: { id: service.id }, data: { active: false } });
    expect(await unpaid(member.id, member.id, org.domain)).toEqual([{ team_id: null }]);
    expect(await context()).toBeNull();
    await p.billingService.update({ where: { id: service.id }, data: { active: true } });
    await p.billingAppKey.update({ where: { id: appKey.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await unpaid(member.id, member.id, org.domain)).toEqual([{ team_id: null }]);
    expect(await context()).toBeNull();
    await p.billingAppKey.update({ where: { id: appKey.id }, data: { revokedAt: new Date() } });
    expect(await unpaid(member.id, member.id, org.domain)).toEqual([{ team_id: null }]);
    expect(await context()).toBeNull();
    await p.billingAppKey.create({ data: { serviceId: service.id, purpose: appKey.purpose, name: 'Rotated seat key',
      keyPrefix: 'uoa_test_rotated', secretDigest: 'rotated-scope-test-digest', actorIssuer: appKey.actorIssuer,
      actorAudience: appKey.actorAudience, actorKeyId: 'rotated', actorPublicJwk: {}, checkoutReturnOrigins: appKey.checkoutReturnOrigins } });
    let pending = true;
    const invoices = new Map<string, { id: string; status: string; livemode: boolean; currency: string; customer: string;
      billing_reason: string; parent: { subscription_details: { subscription: string } } }>();
    const update = vi.fn(async (_id, params) => {
      if (params.proration_behavior === 'none') { item.quantity = params.items[0].quantity; return remote; }
      const invoice = { id: 'in_' + (invoices.size + 1), status: pending ? 'open' : 'paid', livemode: false,
        currency: 'eur', customer: 'cus_seat', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: remote.id } } };
      invoices.set(invoice.id, invoice);
      if (!pending) item.quantity = params.items[0].quantity;
      return { ...remote, latest_invoice: invoice, pending_update: pending ? {} : null };
    });
    const stripe = { subscriptions: { retrieve: async () => remote, update }, invoices: { retrieve: async (id: string) => invoices.get(id) },
      accounts: { retrieveCurrent: async () => ({ id: acct.stripeAccountId }) } };
    const cycle = () => runAnniversarySeatCycle({ prisma: p, stripe: stripe as never, livemode: false, now: () => now });
    await Promise.all([cycle(), cycle()]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await p.billingAutomaticSeatChange.findFirst()).toMatchObject({ delta: 1, fromQuantity: 1, toQuantity: 2,
      completedAt: null, stripeInvoiceId: 'in_1', failureCode: 'PAYMENT_REQUIRED' });
    expect(await context()).toBeNull();
    await expect(invite()).rejects.toThrow('complete the seat payment');
    const first = invoices.get('in_1'); if (!first) throw new Error('Missing seat invoice');
    pending = false; first.status = 'paid'; item.quantity = 2; now = new Date(now.getTime() + 61000);
    await cycle();
    expect(update).toHaveBeenCalledTimes(1);
    expect((await context())?.teams).toContain(team.id);
    const identity = { orgId_userId: { orgId: org.id, userId: member.id } };
    remote.status = 'past_due';
    await p.$transaction(tx => syncBaseStripeSubscription(tx, remote as never, acct));
    await p.orgMember.update({ where: identity, data: { status: 'REMOVED' } });
    await cycle();
    expect(item.quantity).toBe(1);
    expect(await context()).toBeNull();
    remote.status = 'active';
    await p.$transaction(tx => syncBaseStripeSubscription(tx, remote as never, acct));
    await p.orgMember.update({ where: identity, data: { status: 'ACTIVE' } });
    await cycle(); await cycle();
    const evidence = await p.billingAutomaticSeatChange.findMany({ orderBy: { id: 'asc' } });
    expect(evidence.map(row => [row.delta, row.fromQuantity, row.toQuantity, row.stripeInvoiceId])).toEqual([
      [1, 1, 2, 'in_1'], [-1, 2, 1, null], [1, 1, 2, 'in_2'],
    ]);
    expect(evidence.every(row => row.completedAt)).toBe(true);
    expect(update.mock.calls.map(call => call[1].proration_behavior)).toEqual(['always_invoice', 'none', 'always_invoice']);
    expect(invoices.size).toBe(2);
    await expect(p.billingAutomaticSeatChange.delete({ where: { id: evidence[0].id } })).rejects.toThrow('immutable');
    expect(await unpaid(member.id, member.id, org.domain)).toEqual([]);
    const additional = await Promise.all([user('concurrent-one'), user('concurrent-two')]);
    await Promise.all(additional.map(async person => {
      const sent = await p.teamInvite.create({ data: { orgId: org.id, teamId: team.id, email: person.email!, lastSentAt: now } });
      await p.$transaction(async tx => {
        await tx.orgMember.create({ data: { orgId: org.id, userId: person.id, role: 'member' } });
        await tx.teamMember.create({ data: { userId: person.id, teamId: team.id } });
        await tx.teamInvite.update({ where: { id: sent.id }, data: { acceptedUserId: person.id, acceptedAt: now } });
      });
    }));
    await Promise.all([cycle(), cycle()]);
    const joined = await p.billingAutomaticSeatChange.findMany({ where: { userId: { in: additional.map(person => person.id) } },
      orderBy: { id: 'asc' } });
    expect(joined.map(row => [row.fromQuantity, row.toQuantity])).toEqual([[2, 3], [3, 4]]);
    expect(joined.every(row => row.completedAt && row.stripeInvoiceId)).toBe(true);
    expect(new Set(joined.map(row => row.stripeInvoiceId)).size).toBe(2);
    await expect(p.billingAutomaticSeatChange.update({ where: { id: evidence[0].id },
      data: { completedAt: null } })).rejects.toThrow('immutable');
    await expect(p.billingAutomaticSeatChange.update({ where: { id: evidence[0].id },
      data: { userId: founder.id } })).rejects.toThrow('immutable');
  });
});
