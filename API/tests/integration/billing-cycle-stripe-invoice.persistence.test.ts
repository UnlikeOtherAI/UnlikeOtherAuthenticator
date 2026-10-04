import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { captureIssuedStripeBillingCycle }
  from '../../src/services/billing-cycle-stripe-invoice.service.js';
import { allocateStripeCycleCash }
  from '../../src/services/billing-cycle-stripe-allocation.service.js';
import type { BillingCycleDetailV2 } from '../../src/contracts/billing-statement-v1.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { issueStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-issue.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice }
  from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { createStripeInvoiceFixture } from '../helpers/stripe-payment-invoice-fixture.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
const pdf = Buffer.from('%PDF-1.7\nverified cash invoice\n%%EOF');
class MemoryStorage implements BillingInvoicePdfStorage {
  readonly objects = new Map<string, Buffer>();
  async putImmutable(key: string, bytes: Uint8Array) { this.objects.set(key, Buffer.from(bytes)); }
  async read(key: string) { const bytes = this.objects.get(key);
    if (!bytes) throw new Error('MISSING_DOCUMENT'); return bytes; }
}

describe.skipIf(!process.env.DATABASE_URL)('actual Stripe cash source closes a credit-only cycle', () => {
  let db: TestDb; let subscriptionId: string; let accountId: string;
  let serviceId: string; let cycleId: string; let invoiceId: string;
  const storage = new MemoryStorage();
  beforeAll(async () => {
    const created = await createTestDb(); if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const suffix = randomUUID();
    const user = await db.prisma.user.create({ data: { email: `${suffix}@example.test`,
      userKey: `${suffix}@example.test` } });
    const org = await db.prisma.organisation.create({ data: { ownerId: user.id,
      domain: `${suffix}.example.test`, slug: `cycle-${suffix.slice(0, 8)}`, name: 'Cycle customer' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: `cycle-${suffix}`, name: 'Cycle service' } });
    serviceId = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'flat', version: 1, name: 'Monthly', mode: 'STANDARD', collectionMode: 'STRIPE',
      monthlyAmountMinor: 2000n, monthlyChargeBasis: 'FLAT', currency: 'USD', markupBps: 3000,
    } });
    const key = await db.prisma.billingAppKey.create({ data: { serviceId, name: 'Cycle app',
      keyPrefix: `uoa_${suffix.slice(0, 12)}`, secretDigest: 'a'.repeat(64),
      actorIssuer: 'https://app.example.test', actorAudience: 'https://uoa.example.test', actorKeyId: 'cycle',
      actorPublicJwk: { kty: 'RSA', kid: 'cycle', n: 'AQAB', e: 'AQAB' } } });
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${suffix}`, livemode: false } });
    accountId = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId, orgId: org.id, teamId: null, scope: 'ORGANISATION', scopeKey: org.id,
      stripeCustomerId: 'cus_monthly' } });
    const checkout = await db.prisma.billingStripeCheckoutSession.create({ data: {
      accountId, appKeyId: key.id, customerId: customer.id, serviceId, tariffId: tariff.id,
      tariffSource: 'SERVICE_DEFAULT', orgId: org.id, teamId: null, scope: 'ORGANISATION', scopeKey: org.id,
      actorJti: randomUUID(), requestedByUserId: user.id, successUrlDigest: 'a'.repeat(64),
      cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date('2026-10-05T00:00:00Z') } });
    const subscription = await db.prisma.billingStripeSubscription.create({ data: {
      accountId, checkoutId: checkout.id, customerId: customer.id, serviceId, tariffId: tariff.id,
      tariffSource: 'SERVICE_DEFAULT', orgId: org.id, teamId: null, scope: 'ORGANISATION', scopeKey: org.id,
      stripeSubscriptionId: 'sub_monthly', stripeMonthlyItemId: 'si_monthly', stripeUsageItemId: 'si_metered',
      status: 'active', livemode: false, billableFrom: new Date('2026-08-01T00:00:00Z') } });
    subscriptionId = subscription.id;
    const prepared = await prepareBillingCycleClose({ source: { kind: 'stripe', id: subscriptionId },
      billingMonth: '2026-08' }, { prisma: db.prisma,
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [] }) });
    cycleId = prepared.cycleId;
  });
  afterAll(async () => { await db?.cleanup(); });

  it('does not turn an unpaid quote into an invoice', async () => {
    expect(await captureIssuedStripeBillingCycle({ cycleId }, { prisma: db.prisma, storage })).toBeNull();
    expect(await db.prisma.billingCustomerCycle.count({ where: { state: 'finalized' } })).toBe(0);
  });
  it('freezes actual VAT and paid cash, keeps October payment separate from August usage', async () => {
    const fixture = await createStripeInvoiceFixture(db.prisma, accountId);
    const prepared = await prepareStripePaymentInvoice(fixture.invoice.id, fixture.account,
      db.prisma, fixture.stripe);
    if (!prepared) throw new Error('SOURCE_REQUIRED');
    const invoice = await db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, prepared));
    invoiceId = invoice.id;
    await issueStripePaymentInvoice(invoiceId, { prisma: db.prisma, stripe: fixture.stripe,
      account: fixture.account, storage,
      download: vi.fn().mockResolvedValue(new Response(pdf, { status: 200 })) });
    const result = await captureIssuedStripeBillingCycle({ cycleId }, { prisma: db.prisma, storage });
    const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: { id: result?.cycleId } });
    const value = row.publicSnapshot as unknown as BillingCycleDetailV2;
    expect(value).toMatchObject({ state: 'finalized', period: { month: '2026-08' },
      totals: [{ subscription: { amount_minor: '2000' }, usage_charge: { amount_minor: '0' },
        tax: { amount_minor: '500' }, gross_total: { amount_minor: '2500' },
        credits_applied: { amount_minor: '500' }, total_due: { amount_minor: '2000' },
        total_paid: { amount_minor: '2000' }, outstanding: { amount_minor: '0' } }] });
    expect(value.documents.map((doc) => doc.kind)).toEqual(['monthly_invoice', 'usage_breakdown', 'usage_breakdown']);
    expect(JSON.stringify(value)).not.toMatch(/token|markup|provider_cost/i);
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count()).toBe(1);
    expect(await captureIssuedStripeBillingCycle({ cycleId: row.id }, { prisma: db.prisma, storage })).toEqual(result);
    expect(await db.prisma.billingCustomerCycle.count()).toBe(2);
    const source = await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(source.paidAt.toISOString().slice(0, 7)).toBe('2026-10');
    expect(source.pdfSha256).toBe(createHash('sha256').update(pdf).digest('hex'));
  });
  it('rejects corrupted original legal bytes before creating another cycle', async () => {
    const source = await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    storage.objects.set(source.pdfObjectKey ?? '', Buffer.from('%PDF-corrupted'));
    await expect(captureIssuedStripeBillingCycle({ cycleId }, { prisma: db.prisma, storage }))
      .rejects.toThrow('BILLING_CYCLE_STRIPE_PDF_INTEGRITY');
    expect(await db.prisma.billingCustomerCycle.count()).toBe(2);
  });
});

describe('whole-invoice cash allocation', () => {
  it('allocates exact partial cash by due amount with binary ties and no penny loss', () => {
    const source = [{ id: 'z', due: 1n }, { id: 'A', due: 1n }, { id: 'a', due: 1n }];
    expect([...allocateStripeCycleCash(source, 2n)].sort()).toEqual([['A', 1n], ['a', 1n], ['z', 0n]]);
    expect([...allocateStripeCycleCash([...source].reverse(), 2n)].sort()).toEqual(
      [...allocateStripeCycleCash(source, 2n)].sort());
    expect(() => allocateStripeCycleCash(source, 4n)).toThrow('BILLING_CYCLE_STRIPE_CASH_UNALLOCATABLE');
  });
});
