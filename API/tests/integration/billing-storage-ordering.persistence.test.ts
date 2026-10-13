import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedSmsFinance, smsIds } from '../helpers/sms-financial-fixture.js';
import { applyStorageWebhook, type PreparedStorageWebhook } from '../../src/services/billing-storage-webhook.service.js';

describe.skipIf(!process.env.DATABASE_URL)('storage cash evidence ordering in PostgreSQL', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    await seedSmsFinance(db.prisma, false);
    await db.prisma.billingStorageCatalog.create({ data: { id: 'catalog', serviceId: smsIds.service,
      accountId: smsIds.account, currency: 'EUR', unitAmountMinor: 999n,
      stripeProductId: 'prod_fixture', stripePriceId: 'price_fixture' } });
    await db.prisma.billingCustomerActionIntent.create({ data: { id: 'consent', appKeyId: smsIds.lifecycle,
      serviceId: smsIds.service, orgId: smsIds.org, teamId: smsIds.team, requestedByUserId: smsIds.user,
      authorityScope: 'ORGANISATION', operation: 'storage.mandate', actorJti: 'fixture-consent', actorTokenVersion: 0,
      actorExpiresAt: new Date('2026-10-13T18:00:00Z'), requestDigest: 'a'.repeat(64) } });
    await db.prisma.billingStorageMandate.create({ data: { id: 'mandate', serviceId: smsIds.service, orgId: smsIds.org,
      accountId: smsIds.account, catalogId: 'catalog', appKeyId: smsIds.lifecycle, actionIntentId: 'consent',
      requestedByUserId: smsIds.user, requestedTeamId: smsIds.team, consentVersion: 'company-storage-auto-expansion-v1',
      consentTerms: { synthetic: true }, stripeCustomerId: 'cus_fixture', stripeSetupIntentId: 'seti_fixture',
      stripePaymentMethodId: 'pm_fixture', state: 'accepted', acceptedAt: new Date('2026-10-13T17:00:00Z'),
      successUrl: 'https://app.example.test/admin/billing', cancelUrl: 'https://app.example.test/admin/billing' } });
    await db.prisma.billingStorageSubscription.create({ data: { id: 'storage-subscription', serviceId: smsIds.service,
      orgId: smsIds.org, accountId: smsIds.account, mandateId: 'mandate', catalogId: 'catalog',
      stripeSubscriptionId: 'sub_fixture', stripeItemId: 'si_fixture', purchasedBlocks: 1, pendingBlocks: 2, state: 'active' } });
    for (const [id, from, to] of [['A', 0, 1], ['B', 1, 2]] as const) {
      await db.prisma.billingStorageExpansion.create({ data: { id, serviceId: smsIds.service, orgId: smsIds.org,
        mandateId: 'mandate', subscriptionId: 'storage-subscription', operationId: id,
        minimumBytes: BigInt(to) * 1_000_000_000_000n, fromBlocks: from, toBlocks: to,
        state: id === 'A' ? 'paid' : 'processing', paymentProvenAt: id === 'A' ? new Date('2026-10-13T17:00:00Z') : null } });
      await db.prisma.billingStoragePaymentAttempt.create({ data: { id: `attempt-${id}`, expansionId: id,
        mandateId: 'mandate', generation: 1, stripeSubscriptionId: 'sub_fixture', stripeInvoiceId: `in_${id}` } });
    }
  });
  afterAll(async () => { await db?.cleanup(); });
  async function paid(id: 'A' | 'B', event: string) {
    const [expansion, attempt, mandate, catalog] = await Promise.all([
      db.prisma.billingStorageExpansion.findUniqueOrThrow({ where: { id } }),
      db.prisma.billingStoragePaymentAttempt.findUniqueOrThrow({ where: { id: `attempt-${id}` } }),
      db.prisma.billingStorageMandate.findUniqueOrThrow({ where: { id: 'mandate' } }),
      db.prisma.billingStorageCatalog.findUniqueOrThrow({ where: { id: 'catalog' } }),
    ]);
    await db.prisma.billingStripeWebhookEvent.create({ data: { id: event, accountId: smsIds.account,
      stripeEventId: `evt_${event}`, type: 'invoice.paid', livemode: false, stripeCreatedAt: new Date() } });
    const prepared: PreparedStorageWebhook = { kind: 'invoice', binding: { expansion, attempt, mandate, catalog },
      remote: { id: 'sub_fixture', status: 'active', items: { data: [{ id: 'si_fixture', current_period_start: 1791896400,
        current_period_end: 1794574800 }] } } as unknown as Stripe.Subscription,
      invoice: { id: `in_${id}`, amount_paid: Number(catalog.unitAmountMinor) * expansion.toBlocks,
        currency: 'eur' } as Stripe.Invoice, payment: null, paidAt: new Date('2026-10-13T17:00:00Z'), cashEvidence: { synthetic: event } };
    await db.prisma.$transaction((tx) => applyStorageWebhook(tx, prepared, event));
    return db.prisma.billingStorageSubscription.findUniqueOrThrow({ where: { id: 'storage-subscription' } });
  }
  it('keeps B pending after A paid, then never reduces B paid capacity with late A cash or renewal', async () => {
    expect(await paid('A', 'old-A')).toMatchObject({ purchasedBlocks: 1, pendingBlocks: 2 });
    expect(await paid('B', 'paid-B')).toMatchObject({ purchasedBlocks: 2, pendingBlocks: 0 });
    expect(await paid('A', 'late-A')).toMatchObject({ purchasedBlocks: 2, pendingBlocks: 0 });
    expect(await paid('A', 'late-A-renewal')).toMatchObject({ purchasedBlocks: 2, pendingBlocks: 0 });
    expect(await db.prisma.billingStoragePaymentEvidence.count()).toBe(2);
  });
});
