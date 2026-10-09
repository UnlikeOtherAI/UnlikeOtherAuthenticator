import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { recurringAddonMetadata } from '../../src/services/billing-recurring-addon-stripe-binding.service.js';
import { verifySmsNumberRefund } from '../../src/services/billing-sms-refund-recovery.service.js';

const actor = { userId: 'operator-1', email: 'operator@example.test', tokenVersion: 2, domain: 'admin.example.com' };
const input = { subscription_id: 'sub-local', refund_ids: ['re_fixture'], reason: 'Verify original full cash refund after unavailable acquisition.', verify_existing_refunds: true } as const;
const now = new Date('2026-10-08T12:00:00Z');
// Arbitrary synthetic cash amount; this fixture does not rate provider pricing.
const syntheticPaidMinor = 1234;
function fixture() {
  const account = { id: 'account-1', stripeAccountId: 'acct_fixture', livemode: false };
  const resource = { id: 'resource-1', state: 'refund_required', serviceId: 'nessie', orgId: 'org-1',
    offerId: 'offer-1', quoteId: 'quote-1', accountSid: null, phoneNumberSid: null };
  const checkout = { id: 'checkout-1', serviceId: 'nessie', offerId: 'offer-1', offerKey: 'sms-number',
    orgId: 'org-1', teamId: null, requestedTeamId: 'team-1', subscribingUserId: null,
    scope: 'ORGANISATION' as const, scopeKey: 'org-1' };
  const local = { ...checkout, id: 'sub-local', accountId: 'account-1', account, catalogId: 'catalog-1',
    customerId: 'customer-1', stripeSubscriptionId: 'sub_fixture', stripeItemId: 'si_fixture',
    initialInvoiceId: 'in_fixture', initialInvoicePaidAt: now, activationWebhookEventId: 'event-1', livemode: false,
    checkout, customer: { accountId: 'account-1', orgId: 'org-1', stripeCustomerId: 'cus_fixture' },
    catalog: { accountId: 'account-1', offerId: 'offer-1', monthlyAmountMinor: BigInt(syntheticPaidMinor), currency: 'USD', stripePriceId: 'price_fixture' },
    offer: { resourceKind: 'sms_mobile_number', resourceId: 'resource-1', monthlyAmountMinor: BigInt(syntheticPaidMinor), currency: 'USD' } };
  const metadata = recurringAddonMetadata(checkout, account);
  const remote = { id: 'sub_fixture', customer: 'cus_fixture', livemode: false, status: 'canceled', metadata,
    discounts: [], items: { data: [{ id: 'si_fixture', quantity: 1, discounts: [], price: {
      id: 'price_fixture', recurring: { interval: 'month', usage_type: 'licensed' } } }] } };
  const invoice = { id: 'in_fixture', livemode: false, status: 'paid', billing_reason: 'subscription_create',
    customer: 'cus_fixture', currency: 'usd', amount_paid: syntheticPaidMinor, amount_due: syntheticPaidMinor, amount_remaining: 0,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_fixture', metadata } },
    lines: { has_more: false, data: [{ amount: syntheticPaidMinor, quantity: 1, parent: { type: 'subscription_item_details',
      subscription_item_details: { subscription: 'sub_fixture', subscription_item: 'si_fixture', proration: false } },
      pricing: { price_details: { price: 'price_fixture' } } }] } };
  const refund = { id: 're_fixture', charge: 'ch_fixture', payment_intent: 'pi_fixture', status: 'succeeded',
    currency: 'usd', amount: syntheticPaidMinor, balance_transaction: 'txn_fixture', failure_balance_transaction: null };
  const balance = { id: 'txn_fixture', source: 're_fixture', amount: -syntheticPaidMinor, currency: 'usd', exchange_rate: null,
    type: 'refund', status: 'available', created: now.getTime() / 1000 };
  const proof: { state: string; refundEvidenceDigest: string | null; refundedAt: Date | null } = {
    state: 'refund_required', refundEvidenceDigest: null, refundedAt: null };
  const db = { billingSmsNumberResource: { findUnique: vi.fn(async () => resource) },
    billingRecurringAddonSubscription: { findUnique: vi.fn(async () => local) },
    $queryRaw: vi.fn(async (query: { sql: string }) => query.sql.includes('FROM billing_sms_number_resources')
      ? [proof] : [{ id: actor.userId, email: actor.email, tokenVersion: 2, role: 'SUPERUSER' }]),
    $executeRaw: vi.fn(async () => 1), adminAuditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn() };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  const stripe = { accounts: { retrieveCurrent: vi.fn(async () => ({ id: 'acct_fixture' })) },
    subscriptions: { retrieve: vi.fn(async () => remote), cancel: vi.fn() }, invoices: { retrieve: vi.fn(async () => invoice),
      list: vi.fn(async () => ({ data: [invoice], has_more: false })) },
    invoicePayments: { list: vi.fn(async () => ({ has_more: false, data: [{ id: 'ip_fixture', invoice: 'in_fixture',
      livemode: false, status: 'paid', currency: 'usd', amount_paid: syntheticPaidMinor, status_transitions: { paid_at: now.getTime() / 1000 },
      payment: { type: 'payment_intent', payment_intent: 'pi_fixture' } }] })) },
    paymentIntents: { retrieve: vi.fn(async () => ({ id: 'pi_fixture', livemode: false, status: 'succeeded',
      customer: 'cus_fixture', currency: 'usd', amount_received: syntheticPaidMinor, latest_charge: 'ch_fixture' })) },
    charges: { retrieve: vi.fn(async () => ({ id: 'ch_fixture', payment_intent: 'pi_fixture', livemode: false,
      customer: 'cus_fixture', currency: 'usd', status: 'succeeded', paid: true, captured: true, amount_captured: syntheticPaidMinor })) },
    refunds: { retrieve: vi.fn(async () => refund), create: vi.fn() },
    balanceTransactions: { retrieve: vi.fn(async () => balance) } };
  const run = (value = { ...input, refund_ids: [...input.refund_ids] }) => verifySmsNumberRefund('resource-1', value, actor,
    { prisma: db as unknown as PrismaClient, stripe: stripe as unknown as Stripe, livemode: false });
  return { resource, local, remote, invoice, refund, balance, proof, db, stripe, run };
}
beforeEach(() => vi.stubEnv('ADMIN_AUTH_DOMAIN', actor.domain));
afterEach(() => vi.unstubAllEnvs());
it('proves exact original cash/refund/balance and canceled subscription, then commits immutable completion and audit only', async () => {
  const f = fixture(); const result = await f.run();
  expect(result).toMatchObject({ resource_id: 'resource-1', state: 'ended', refunded_at: now.toISOString() });
  expect(result.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.db.$executeRaw).toHaveBeenCalledTimes(1); expect(f.db.adminAuditLog.create).toHaveBeenCalledTimes(1);
  expect(f.stripe.refunds.create).not.toHaveBeenCalled(); expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  const serialized = JSON.stringify(f.db.adminAuditLog.create.mock.calls[0]);
  expect(serialized).toContain(actor.userId); expect(serialized).toContain(input.reason);
  expect(serialized).toContain('in_fixture'); expect(serialized).toContain('re_fixture');
});
it('refuses pending/partial/wrong-currency/unrelated refunds, wrong balance sources and unproven cash without writes', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.refund.status = 'pending'; },
    (f: ReturnType<typeof fixture>) => { f.refund.amount = syntheticPaidMinor - 1; f.balance.amount = -(syntheticPaidMinor - 1); },
    (f: ReturnType<typeof fixture>) => { f.refund.currency = 'eur'; },
    (f: ReturnType<typeof fixture>) => { f.refund.charge = 'ch_other'; },
    (f: ReturnType<typeof fixture>) => { f.balance.source = 're_other'; },
    (f: ReturnType<typeof fixture>) => { f.balance.amount = -(syntheticPaidMinor - 1); },
    (f: ReturnType<typeof fixture>) => { f.invoice.amount_paid = 0; },
  ]) {
    const f = fixture(); mutate(f); await expect(f.run()).rejects.toThrow();
    expect(f.db.$executeRaw).not.toHaveBeenCalled(); expect(f.db.adminAuditLog.create).not.toHaveBeenCalled();
  }
});
it('refuses cross-account/product/org/offer/mode binding and ongoing subscriptions', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.local.account.stripeAccountId = 'acct_other'; },
    (f: ReturnType<typeof fixture>) => { f.local.serviceId = 'deepwater'; },
    (f: ReturnType<typeof fixture>) => { f.local.orgId = 'org-other'; },
    (f: ReturnType<typeof fixture>) => { f.local.offer.resourceId = 'resource-other'; },
    (f: ReturnType<typeof fixture>) => { f.local.livemode = true; },
    (f: ReturnType<typeof fixture>) => { f.remote.status = 'active'; },
  ]) { const f = fixture(); mutate(f); await expect(f.run()).rejects.toThrow(); expect(f.db.$executeRaw).not.toHaveBeenCalled(); }
});
it('rechecks locked resource and operator authority; exact evidence replay never adds another audit or state write', async () => {
  const f = fixture(); const result = await f.run();
  f.db.$executeRaw.mockClear(); f.db.adminAuditLog.create.mockClear();
  f.resource.state = 'ended'; f.proof.state = 'ended'; f.proof.refundEvidenceDigest = result.evidence_digest;
  f.proof.refundedAt = new Date(result.refunded_at);
  expect(await f.run()).toEqual(result); expect(f.db.$executeRaw).not.toHaveBeenCalled(); expect(f.db.adminAuditLog.create).not.toHaveBeenCalled();
  f.proof.refundEvidenceDigest = 'b'.repeat(64); await expect(f.run()).rejects.toThrow('STATE_CHANGED');
  const changed = fixture(); changed.proof.state = 'active';
  await expect(changed.run()).rejects.toThrow('STATE_CHANGED'); expect(changed.db.$executeRaw).not.toHaveBeenCalled();
  const revoked = fixture(); revoked.db.$queryRaw.mockResolvedValue([]);
  await expect(revoked.run()).rejects.toThrow('AUTHORITY_REQUIRED'); expect(revoked.db.$executeRaw).not.toHaveBeenCalled();
});
it('refuses additional paid or collectible invoices and an incomplete invoice inventory', async () => {
  for (const status of ['paid', 'open', 'draft']) {
    const f = fixture(); f.stripe.invoices.list.mockResolvedValue({ data: [f.invoice, {
      ...f.invoice, id: 'in_renewal', status, amount_remaining: status === 'paid' ? 0 : syntheticPaidMinor,
    }], has_more: false });
    await expect(f.run()).rejects.toThrow('ADDITIONAL_INVOICES_UNRESOLVED');
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  }
  const incomplete = fixture(); incomplete.stripe.invoices.list.mockResolvedValue({ data: [incomplete.invoice], has_more: true });
  await expect(incomplete.run()).rejects.toThrow('ADDITIONAL_INVOICES_UNRESOLVED');
  expect(incomplete.db.$executeRaw).not.toHaveBeenCalled();
});
