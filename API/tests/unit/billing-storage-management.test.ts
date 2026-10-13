import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { storageManagementSnapshot } from '../../src/services/billing-storage-management.service.js';

function fixture(kind: 'initial' | 'expansion' | 'renewal') {
  const expansion = { id: 'expansion', serviceId: 'service', orgId: 'company', fromBlocks: kind === 'initial' ? 0 : 1,
    toBlocks: kind === 'initial' ? 1 : 2, state: kind === 'renewal' ? 'paid' : 'processing' };
  const attempt = { id: 'attempt', expansionId: expansion.id, mandateId: 'mandate', stripeSubscriptionId: 'sub_storage',
    stripeInvoiceId: 'in_storage' };
  const metadata = { uoa_storage_attempt_id: attempt.id, uoa_storage_expansion_id: expansion.id,
    uoa_storage_mandate_id: attempt.mandateId, uoa_service: 'nessie' };
  const mandate = { id: 'mandate', catalogId: 'catalog', accountId: 'account', stripeCustomerId: 'cus_company', state: 'accepted' };
  const catalog = { id: 'catalog', accountId: 'account', currency: 'EUR', unitAmountMinor: 999n, stripePriceId: 'price_storage' };
  const failure = { id: 'storage-debt', category: 'storage', storageExpansionId: expansion.id, invoiceId: 'in_storage',
    graceEndsAt: new Date('2026-10-19T18:00:00Z') };
  const earlierSeat = { id: 'seat-debt', category: 'seat', storageExpansionId: null, invoiceId: 'in_seat',
    graceEndsAt: new Date('2026-10-16T18:00:00Z') };
  const line = { pricing: { price_details: { price: catalog.stripePriceId } }, currency: 'eur', discounts: [],
    quantity: expansion.toBlocks, amount: 999 * expansion.toBlocks, period: { start: 1791896400, end: 1794574800 },
    parent: { subscription_item_details: { subscription_item: 'si_storage', proration: kind === 'expansion' } } };
  const invoice = { id: 'in_storage', livemode: false, customer: 'cus_company', currency: 'eur',
    collection_method: 'charge_automatically', discounts: [], parent: { subscription_details: { subscription: 'sub_storage', metadata } },
    lines: { has_more: false, data: [line] }, billing_reason: kind === 'expansion' ? 'subscription_update' : 'subscription_cycle',
    amount_due: 999 * expansion.toBlocks + 200, amount_paid: 0, status: 'open',
    hosted_invoice_url: 'https://invoice.stripe.com/i/recovery' };
  const remote = { id: 'sub_storage', livemode: false, customer: 'cus_company', status: 'past_due', metadata,
    collection_method: 'charge_automatically', discounts: [],
    items: { data: [{ id: 'si_storage', price: { id: catalog.stripePriceId }, discounts: [] }] } };
  const product = { id: 'prod_storage', active: true, livemode: false,
    metadata: { uoa_kind: 'company_storage', uoa_service: 'nessie', contract_version: '1' } };
  const price = { id: 'price_storage', product: product.id, active: true, livemode: false, type: 'recurring',
    billing_scheme: 'per_unit', transform_quantity: null, currency: 'eur', unit_amount: 999,
    lookup_key: 'uoa_nessie_storage_eur_tb_month_v1',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null, trial_period_days: null },
    metadata: { uoa_kind: 'storage_block', uoa_service: 'nessie', contract_version: '1', storage_block_bytes: '1000000000000' } };
  const prisma = { billingStripeAccount: { upsert: async () => ({ id: 'account', livemode: false }) },
    billingOrganisationRegion: { findUnique: async () => ({ currency: 'EUR' }) },
    billingStorageMandate: { findFirst: async () => mandate, findUnique: async () => mandate },
    billingStorageCatalog: { findFirst: async () => catalog, findUnique: async () => catalog, findUniqueOrThrow: async () => catalog },
    billingStorageExpansion: { findFirst: async () => kind === 'renewal' ? null : expansion, findUnique: async () => expansion },
    billingStoragePaymentAttempt: { findUnique: async () => attempt, findFirstOrThrow: async () => attempt },
    billingStorageSubscription: { findUnique: async () => ({ catalogId: catalog.id, purchasedBlocks: kind === 'initial' ? 0 : 2,
      pendingBlocks: kind === 'renewal' ? 0 : expansion.toBlocks, currentPeriodStart: null, currentPeriodEnd: null }) },
    billingCommercialIncident: { findMany: async () => [earlierSeat, failure] } } as unknown as PrismaClient;
  const stripe = { accounts: { retrieveCurrent: async () => ({ id: 'acct_synthetic' }) },
    prices: { retrieve: async () => price }, products: { retrieve: async () => product },
    invoices: { retrieve: async () => invoice }, subscriptions: { retrieve: async () => remote } } as unknown as Stripe;
  return { prisma, stripe, invoice, remote, price, failure, earlierSeat };
}

describe('current storage invoice recovery', () => {
  async function read(data: ReturnType<typeof fixture>) {
    return storageManagementSnapshot(data.prisma, { serviceId: 'service', privateAtCost: false,
      request: { product: 'nessie', organisation_id: 'company', team_id: 'team', user_id: 'owner' } },
    { stripe: data.stripe, livemode: false, now: () => new Date('2026-10-16T17:59:50Z') });
  }
  it.each(['initial', 'expansion', 'renewal'] as const)('exposes the actual %s invoice independently of company seat deadline', async (kind) => {
    const data = fixture(kind);
    const result = await read(data);
    expect(result.state).toBe('recovery_required');
    expect(result.payment_recoveries).toEqual([{ incident_id: 'storage-debt', invoice_id: 'in_storage',
      invoice_url: 'https://invoice.stripe.com/i/recovery', invoice_amount_minor: data.invoice.amount_due.toString(),
      invoice_currency: 'EUR', grace_ends_at: data.failure.graceEndsAt.toISOString() }]);
    expect(result.valid_until).toBe(data.earlierSeat.graceEndsAt.toISOString());
    if (kind === 'renewal') expect(result.pending_expansion).toBeNull();
    else expect(result.pending_expansion?.invoice_currency).toBe('EUR');
  });
  it('retains unresolved debt without a second pay link when paid proof has not committed', async () => {
    const data = fixture('renewal'); data.invoice.status = 'paid';
    const result = await read(data);
    expect(result.payment_recoveries[0]?.invoice_url).toBeNull();
    expect(result.state).toBe('recovery_required');
  });
  it('rejects wrong customer, currency, quantity transform and untrusted payment origins', async () => {
    for (const mutate of [
      (data: ReturnType<typeof fixture>) => { data.invoice.customer = 'cus_other_company'; },
      (data: ReturnType<typeof fixture>) => { data.invoice.currency = 'usd'; },
      (data: ReturnType<typeof fixture>) => { Object.assign(data.price, { transform_quantity: { divide_by: 100, round: 'up' } }); },
      (data: ReturnType<typeof fixture>) => { data.invoice.hosted_invoice_url = 'https://api.nessie.works/admin/billing'; },
    ]) { const data = fixture('renewal'); mutate(data); await expect(read(data)).rejects.toThrow(); }
  });
});
