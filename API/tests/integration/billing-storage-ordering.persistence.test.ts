import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedSmsFinance, smsIds, smsCredential } from '../helpers/sms-financial-fixture.js';
import { applyStorageWebhook, type PreparedStorageWebhook } from '../../src/services/billing-storage-webhook.service.js';
import { applyCommercialPayment } from '../../src/services/billing-commercial-incident.service.js';
import { effectiveStorageCapacity } from '../../src/services/billing-storage-expansion.service.js';
import { recoverStorage } from '../../src/services/billing-storage-recovery.service.js';
import { billingActorAudience } from '../../src/services/billing-actor-audience.service.js';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

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
        currency: 'eur', lines: { data: [{ amount: 999, period: { start: 1791896400, end: 1794574800 } }] } } as Stripe.Invoice,
      payment: null, paidAt: new Date('2026-10-13T17:00:00Z'), cashEvidence: { synthetic: event } };
    await db.prisma.$transaction((tx) => applyStorageWebhook(tx, prepared, event));
    return db.prisma.billingStorageSubscription.findUniqueOrThrow({ where: { id: 'storage-subscription' } });
  }
  it('keeps B pending after A paid, then never reduces B paid capacity with late A cash or renewal', async () => {
    expect(await paid('A', 'old-A')).toMatchObject({ purchasedBlocks: 1, pendingBlocks: 2 });
    expect(await paid('B', 'paid-B')).toMatchObject({ purchasedBlocks: 2, pendingBlocks: 0 });
    expect(await paid('A', 'late-A')).toMatchObject({ purchasedBlocks: 2, pendingBlocks: 0 });
    expect(await paid('A', 'late-A-renewal')).toMatchObject({ purchasedBlocks: 2, pendingBlocks: 0 });
    expect(await db.prisma.billingStoragePaymentEvidence.count()).toBe(2);
    expect((await db.prisma.billingStorageSubscription.findUniqueOrThrow({ where: { id: 'storage-subscription' } })).paidThrough)
      .toEqual(new Date(1794574800 * 1000));
  });
  it('preserves original weekday deadlines across retries and chooses the earliest deadline after timezone changes', async () => {
    await db.prisma.clientDomain.create({ data: { domain: 'authentication.unlikeotherai.com', label: 'Fixture source' } });
    await db.prisma.billingProductEnrollment.create({ data: { serviceId: smsIds.service, orgId: smsIds.org,
      sourceDomain: 'authentication.unlikeotherai.com', billingTimezone: 'America/New_York' } });
    async function payment(invoice: string, expansion: string, failedAt: Date, paid: boolean, event: string) {
      await db.prisma.billingStripeWebhookEvent.create({ data: { id: event, accountId: smsIds.account,
        stripeEventId: `evt_${event}`, type: paid ? 'invoice.paid' : 'invoice.payment_action_required', livemode: false,
        stripeCreatedAt: failedAt } });
      await db.prisma.$transaction((tx) => applyCommercialPayment(tx, { serviceId: smsIds.service,
        orgId: smsIds.org, accountId: smsIds.account, category: 'storage', invoiceId: invoice,
        storageExpansionId: expansion, failedAt, paid }, event, failedAt));
    }
    await payment('in_first-debt', 'A', new Date('2026-10-09T23:00:00Z'), false, 'first-failure');
    await db.prisma.billingProductEnrollment.update({ where: { serviceId_orgId: { serviceId: smsIds.service, orgId: smsIds.org } },
      data: { billingTimezone: 'Asia/Tokyo' } });
    await payment('in_second-debt', 'B', new Date('2026-10-10T01:00:00Z'), false, 'later-failure');
    await payment('in_second-debt', 'B', new Date('2026-10-12T14:00:00Z'), false, 'reordered-retry');
    const second = await db.prisma.billingCommercialIncident.findUniqueOrThrow({ where: {
      accountId_invoiceId: { accountId: smsIds.account, invoiceId: 'in_second-debt' } } });
    expect(second.failedAt).toEqual(new Date('2026-10-10T01:00:00Z'));
    expect(second.graceEndsAt).toEqual(new Date('2026-10-12T15:00:00Z'));
    const grace = await effectiveStorageCapacity(db.prisma, smsIds.service, smsIds.org, new Date('2026-10-12T14:00:00Z'));
    expect(grace.incident?.id).toBe(second.id); expect(grace.restricted).toBe(false);
    expect((await effectiveStorageCapacity(db.prisma, smsIds.service, smsIds.org, new Date('2026-10-12T16:00:00Z'))).restricted).toBe(true);
    await payment('in_second-debt', 'B', new Date('2026-10-12T16:00:00Z'), true, 'second-paid');
    expect((await effectiveStorageCapacity(db.prisma, smsIds.service, smsIds.org, new Date('2026-10-12T23:00:00Z'))).restricted).toBe(true);
    await expect(db.prisma.billingCommercialIncident.update({ where: { id: second.id },
      data: { graceEndsAt: new Date('2026-10-20T00:00:00Z') } })).rejects.toThrow();
  });
  it('keeps Friday-to-Monday capacity after23h expiry and replaces the exact terminal attempt once without restarting grace', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...await exportJWK(pair.publicKey), kid: 'weekend-recovery', alg: 'RS256', use: 'sig' };
    await db.prisma.billingAppKey.update({ where: { id: smsIds.lifecycle }, data: { actorKeyId: jwk.kid, actorPublicJwk: jwk } });
    const credential = { ...smsCredential, id: smsIds.lifecycle, purpose: 'CUSTOMER_LIFECYCLE' as const,
      actorKeyId: jwk.kid, actorPublicJwk: jwk, checkoutReturnOrigins: ['https://app.example.test'] };
    const user = await db.prisma.user.create({ data: { email: 'weekend@example.test', userKey: 'weekend@example.test' } });
    const org = await db.prisma.organisation.create({ data: { ownerId: user.id, domain: 'weekend.example.test', name: 'Weekend', slug: 'weekend' } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'admin' } });
    await db.prisma.billingProductEnrollment.create({ data: { serviceId: smsIds.service, orgId: org.id,
      sourceDomain: 'authentication.unlikeotherai.com', billingTimezone: 'UTC' } });
    const consent = await db.prisma.billingCustomerActionIntent.create({ data: { appKeyId: smsIds.lifecycle, serviceId: smsIds.service,
      orgId: org.id, teamId: team.id, requestedByUserId: user.id, authorityScope: 'ORGANISATION', operation: 'storage_mandate_setup',
      actorJti: 'weekend-consent', actorTokenVersion: 0, actorExpiresAt: new Date(Date.now() + 60_000), requestDigest: 'd'.repeat(64) } });
    const mandate = await db.prisma.billingStorageMandate.create({ data: { serviceId: smsIds.service, orgId: org.id,
      accountId: smsIds.account, catalogId: 'catalog', appKeyId: smsIds.lifecycle, actionIntentId: consent.id,
      requestedByUserId: user.id, requestedTeamId: team.id, consentVersion: 'company-storage-auto-expansion-v1', consentTerms: { synthetic: true },
      stripeCustomerId: 'cus_weekend', stripeSetupIntentId: 'seti_weekend', stripePaymentMethodId: 'pm_weekend', state: 'accepted',
      acceptedAt: new Date(), successUrl: 'https://app.example.test/admin/billing', cancelUrl: 'https://app.example.test/admin/billing' } });
    const storage = await db.prisma.billingStorageSubscription.create({ data: { serviceId: smsIds.service, orgId: org.id, accountId: smsIds.account,
      mandateId: mandate.id, catalogId: 'catalog', stripeSubscriptionId: 'sub_expired', stripeItemId: 'si_expired',
      purchasedBlocks: 0, pendingBlocks: 1, state: 'incomplete_expired' } });
    const expansion = await db.prisma.billingStorageExpansion.create({ data: { serviceId: smsIds.service, orgId: org.id,
      mandateId: mandate.id, subscriptionId: storage.id, operationId: 'weekend-first-block', minimumBytes: 1_000_000_000_000n,
      fromBlocks: 0, toBlocks: 1, state: 'failed' } });
    const attempt = await db.prisma.billingStoragePaymentAttempt.create({ data: { expansionId: expansion.id, mandateId: mandate.id,
      generation: 1, stripeSubscriptionId: 'sub_expired', stripeInvoiceId: 'in_expired', firstAttemptedAt: new Date('2026-10-09T18:00:00Z') } });
    const event = await db.prisma.billingStripeWebhookEvent.create({ data: { accountId: smsIds.account, stripeEventId: 'evt_weekend_failed',
      type: 'invoice.payment_failed', livemode: false, stripeCreatedAt: new Date('2026-10-09T18:00:00Z') } });
    await db.prisma.$transaction((tx) => applyCommercialPayment(tx, { serviceId: smsIds.service, orgId: org.id, accountId: smsIds.account,
      category: 'storage', invoiceId: 'in_expired', storageExpansionId: expansion.id, paid: false,
      failedAt: new Date('2026-10-09T18:00:00Z') }, event.id));
    const grace = await effectiveStorageCapacity(db.prisma, smsIds.service, org.id, new Date('2026-10-12T17:00:00Z'));
    expect(grace.bytes).toBe(1_000_000_000_000n); expect(grace.restricted).toBe(false);
    expect(grace.incident?.graceEndsAt).toEqual(new Date('2026-10-12T18:00:00Z'));
    const originalDeadline = grace.incident?.graceEndsAt;
    const metadata = { uoa_storage_attempt_id: attempt.id, uoa_storage_expansion_id: expansion.id, uoa_storage_mandate_id: mandate.id, uoa_service: 'nessie' };
    const expired = { id: 'sub_expired', livemode: false, customer: 'cus_weekend', status: 'incomplete_expired', metadata,
      latest_invoice: 'in_expired', collection_method: 'charge_automatically', discounts: [],
      items: { data: [{ id: 'si_expired', price: { id: 'price_fixture' }, discounts: [] }] } };
    const outcomes = new Map<string, Record<string, unknown>>();
    const stripe = { accounts: { retrieveCurrent: async () => ({ id: 'acct_sms_fixture' }) },
      paymentMethods: { retrieve: async () => ({ id: 'pm_weekend', customer: 'cus_weekend', livemode: false }) },
      invoices: { retrieve: async () => ({ id: 'in_expired', livemode: false, customer: 'cus_weekend', status: 'void', amount_paid: 0,
        currency: 'eur', collection_method: 'charge_automatically', discounts: [], billing_reason: 'subscription_create',
        parent: { subscription_details: { subscription: 'sub_expired', metadata } }, lines: { has_more: false, data: [{
          pricing: { price_details: { price: 'price_fixture' } }, currency: 'eur', discounts: [], quantity: 1, amount: 999,
          period: { start: 1791568800, end: 1794247200 }, parent: { subscription_item_details: { subscription_item: 'si_expired', proration: false } },
        }] } }) },
      products: { retrieve: async () => ({ id: 'prod_fixture', livemode: false, active: true,
        metadata: { uoa_kind: 'company_storage', uoa_service: 'nessie', contract_version: '1' } }) },
      prices: { retrieve: async () => ({ id: 'price_fixture', livemode: false, active: true, product: 'prod_fixture', type: 'recurring', currency: 'eur',
        unit_amount: 999, billing_scheme: 'per_unit', transform_quantity: null, lookup_key: 'uoa_nessie_storage_eur_tb_month_v1',
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null, trial_period_days: null },
        metadata: { uoa_kind: 'storage_block', uoa_service: 'nessie', storage_block_bytes: '1000000000000', contract_version: '1' } }) },
      subscriptions: { retrieve: async () => expired, list: async () => ({ data: [...outcomes.values()], has_more: false }),
        create: async (input: Stripe.SubscriptionCreateParams, options: Stripe.RequestOptions) => {
          const key = options.idempotencyKey; if (!key) throw new Error('IDEMPOTENCY_REQUIRED');
          const existing = outcomes.get(key); if (existing) return existing;
          const created = { id: 'sub_replacement', livemode: false, customer: input.customer, metadata: input.metadata,
            status: 'incomplete', latest_invoice: 'in_replacement', items: { data: [{ id: 'si_replacement', quantity: 1,
              price: { id: 'price_fixture' }, current_period_start: 1791896400, current_period_end: 1794574800 }] } };
          outcomes.set(key, created); return created;
        } } } as unknown as Stripe;
    const body = { product: 'nessie', organisation_id: org.id, team_id: team.id, user_id: user.id, expansion_id: expansion.id };
    async function actor(jti: string) { return new SignJWT({ product: 'nessie', organisation_id: org.id, team_id: team.id, tv: 0 })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(credential.actorIssuer)
      .setAudience(billingActorAudience('/billing/v1/storage/recover')).setSubject(user.id).setJti(jti)
      .setIssuedAt().setExpirationTime('60s').sign(pair.privateKey); }
    const token = await actor('weekend-recover');
    const result = await recoverStorage({ request: body, credential, actorToken: token }, { prisma: db.prisma, stripe, livemode: false });
    const replay = await recoverStorage({ request: body, credential, actorToken: token }, { prisma: db.prisma, stripe, livemode: false });
    expect(result).toMatchObject({ state: 'payment_pending' }); expect(replay.attempt_id).toBe(result.attempt_id);
    expect(await db.prisma.billingStoragePaymentAttempt.count({ where: { expansionId: expansion.id } })).toBe(2); expect(outcomes.size).toBe(1);
    const debt = await db.prisma.billingCommercialIncident.findUniqueOrThrow({ where: { accountId_invoiceId: { accountId: smsIds.account, invoiceId: 'in_expired' } } });
    expect(debt.graceEndsAt).toEqual(originalDeadline); expect(debt.resolvedAt).toBeNull();
  });
});
