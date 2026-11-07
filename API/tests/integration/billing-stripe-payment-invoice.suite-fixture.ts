import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, vi } from 'vitest';

import type { BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';

import { prepareStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';

import { createTestDb } from '../helpers/test-db.js';
import { createStripeInvoiceFixture } from '../helpers/stripe-payment-invoice-fixture.js';

export type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

export const endsAt = new Date('2026-09-01T00:00:00.000Z');

export const paidAt = new Date('2026-10-01T00:00:00.000Z');

export const pdf = Buffer.from('%PDF-1.7\nverified invoice\n%%EOF');

export let db: TestDb;

export let accountId: string;

export let serviceId: string;

export let tariffId: string;

export let orgId: string;

export let product: string;

export let ownerId: string;

export let teamManagerId: string;

export let selectedTeamId: string;

export function context(userId = ownerId): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: product,
      name: 'Monthly service' } } as BillingCycleContext['credential'],
    actorToken: 'verified-test-actor', endpoint: '/billing/v1/invoices/list',
    request: { product, organisationId: orgId, teamId: selectedTeamId, userId } };
  }

export const setup = (id?: string) => createStripeInvoiceFixture(db.prisma, accountId, id);

export async function prepare(fixture: Awaited<ReturnType<typeof setup>>) {
    const prepared = await prepareStripePaymentInvoice(fixture.invoice.id, fixture.account,
      db.prisma, fixture.stripe);
    if (!prepared) throw new Error('SOURCE_REQUIRED');
    return prepared;
  }
export function setupPersistenceSuite() {
beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: `${randomUUID()}@example.test`,
    } });
    ownerId = owner.id;
    const teamManager = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: `${randomUUID()}@example.test`,
    } });
    teamManagerId = teamManager.id;
    const org = await db.prisma.organisation.create({ data: {
      ownerId: owner.id, domain: `${randomUUID()}.example.test`,
      slug: `monthly-${randomUUID().slice(0, 8)}`, name: 'Monthly seat customer',
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId,
      name: 'Selected team', slug: `selected-${randomUUID().slice(0, 8)}` } });
    selectedTeamId = team.id;
    await db.prisma.billingTeamMode.create({ data: { teamId: team.id, sandbox: true, revision: 1 } });
    await db.prisma.orgMember.create({ data: { orgId, userId: owner.id, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id,
      teamRole: 'owner' } });
    await db.prisma.orgMember.create({ data: { orgId, userId: teamManager.id, role: 'member' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: teamManager.id,
      teamRole: 'admin' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: `monthly-${randomUUID()}`, name: 'Monthly service',
    } });
    serviceId = service.id;
    product = service.identifier;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'seat', version: 1, name: 'Seats',
      mode: 'STANDARD', collectionMode: 'STRIPE', markupBps: 3000,
      monthlyAmountMinor: 2500n, monthlyChargeBasis: 'FLAT',
      currency: 'USD',
    } });
    tariffId = tariff.id;
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId, name: 'Monthly key', keyPrefix: `uoa_${randomUUID().slice(0, 12)}`,
      secretDigest: 'a'.repeat(64), actorIssuer: 'https://example.test',
      actorAudience: 'https://uoa.example.test', actorKeyId: 'monthly-key',
      actorPublicJwk: { kty: 'RSA', kid: 'monthly-key', n: 'AQAB', e: 'AQAB' },
    } });
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID().replaceAll('-', '')}`, livemode: false,
    } });
    vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID', account.stripeAccountId);
    vi.stubEnv('STRIPE_SANDBOX_SECRET_KEY', 'rk_test_invoice_fixture');
    vi.stubEnv('STRIPE_SANDBOX_WEBHOOK_SECRET', 'whsec_invoice_fixture');
    vi.stubEnv('STRIPE_LIVE_ACCOUNT_ID', account.stripeAccountId);
    vi.stubEnv('STRIPE_LIVE_SECRET_KEY', 'rk_live_invoice_fixture');
    vi.stubEnv('STRIPE_LIVE_WEBHOOK_SECRET', 'whsec_live_invoice_fixture');
    accountId = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId, orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      stripeCustomerId: 'cus_monthly',
    } });
    const checkout = await db.prisma.billingStripeCheckoutSession.create({ data: {
      billingModeTeamId: selectedTeamId, billingModeRevision: 1,
      accountId, appKeyId: appKey.id, customerId: customer.id,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT',
      orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      actorJti: randomUUID(), requestedByUserId: owner.id,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: new Date('2026-10-02T00:00:00.000Z'),
    } });
    await db.prisma.billingStripeSubscription.create({ data: {
      accountId, checkoutId: checkout.id, customerId: customer.id,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT',
      orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      stripeSubscriptionId: 'sub_monthly', stripeUsageItemId: 'si_metered',
      stripeMonthlyItemId: 'si_monthly', status: 'active', livemode: false,
      currentPeriodStart: endsAt,
      currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
    } });
  });
afterAll(async () => { if (db) await db.cleanup(); vi.unstubAllEnvs(); });
}
