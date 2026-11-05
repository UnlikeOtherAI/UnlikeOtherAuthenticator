// Opt-in, read-only provider replay. Only the fresh PostgreSQL schema is writable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';

import { STRIPE_BILLING_API_VERSION } from '../../src/services/billing-stripe-client.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { createTestDb } from '../helpers/test-db.js';

const [accountId, ...ids] = process.argv.slice(2);
if (!accountId || !/^acct_[a-zA-Z0-9]+$/.test(accountId) || !ids.length || ids.some(id => !/^in_[a-zA-Z0-9]+$/.test(id))) {
  throw new Error('Supply an expected sandbox account and its paid seat invoice IDs');
}
const cli = process.env.STRIPE_CLI_PATH ?? 'stripe';
function command(args: string[]) {
  try { return JSON.parse(execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 35_000 })); }
  catch { throw new Error('Sandbox CLI read failed on ' + args.slice(0, 2).join(' ')); }
}
function get(path: string, params: Record<string, unknown> = {}) {
  const who = command(['whoami', '--format', 'json']);
  assert.equal(who.account_id, accountId); assert.equal(who.mode, 'test');
  const args = ['get', path, '--stripe-version', STRIPE_BILLING_API_VERSION];
  for (const [key, value] of Object.entries(params)) args.push('-d', key + '=' + String(value));
  const result = command(args);
  if (result.error) throw new Error('Stripe refused the sandbox read');
  if ('livemode' in result) assert.equal(result.livemode, false);
  return result;
}
async function* balances(customer: string) {
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const rows = get('/v1/customers/' + customer + '/balance_transactions', { limit: 100, ...(after ? { starting_after: after } : {}) });
    for (const row of rows.data) yield row;
    if (!rows.has_more) return;
    after = rows.data.at(-1)?.id;
    assert.ok(after);
  }
  throw new Error('Balance history exceeds verification bound');
}
const provider = {
  invoices: { retrieve: (id: string) => get('/v1/invoices/' + id),
    listLineItems: (id: string, params: Record<string, unknown>) => get('/v1/invoices/' + id + '/lines', params) },
  invoicePayments: { list: (params: Record<string, unknown>) => get('/v1/invoice_payments', params) },
  paymentIntents: { retrieve: (id: string) => get('/v1/payment_intents/' + id) },
  charges: { retrieve: (id: string) => get('/v1/charges/' + id) },
  customers: { listBalanceTransactions: balances },
} as unknown as Stripe;

async function run() {
  const first = get('/v1/invoices/' + ids[0]);
  const remote = get('/v1/subscriptions/' + first.parent.subscription_details.subscription);
  const item = remote.items.data.find((row: Stripe.SubscriptionItem) => row.price.recurring?.usage_type === 'licensed');
  assert.ok(item && item.price.unit_amount > 0);
  const db = await createTestDb();
  if (!db) throw new Error('An isolated evaluation DATABASE_URL is required');
  const p = db.prisma;
  try {
    const owner = await p.user.create({ data: { userKey: 'eval-seat-owner', email: 'receipt-owner@example.test' } });
    const org = await p.organisation.create({ data: { ownerId: owner.id, name: 'Receipt replay', slug: 'receipt', domain: 'receipt.example' } });
    await p.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    const service = await p.billingService.create({ data: { identifier: 'nessie', name: 'Nessie' } });
    const tariff = await p.billingTariff.create({ data: { serviceId: service.id, key: 'receipt', name: 'Seats', version: 1,
      monthlyAmountMinor: BigInt(item.price.unit_amount), currency: item.price.currency.toUpperCase(), mode: 'STANDARD', markupBps: 0,
      collectionMode: 'STRIPE', monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED',
      usagePaymentMode: 'PREPAID', anniversarySeats: true } });
    const key = await p.billingAppKey.create({ data: { serviceId: service.id, name: 'Receipt replay', keyPrefix: 'eval-receipt',
      secretDigest: 'fixture-only', actorIssuer: 'https://receipt.example', actorAudience: 'https://identity.example',
      actorKeyId: 'fixture', actorPublicJwk: {} } });
    const acct = await p.billingStripeAccount.create({ data: { stripeAccountId: accountId, livemode: false } });
    const customer = await p.billingStripeCustomer.create({ data: { accountId: acct.id, orgId: org.id, scopeKey: org.id,
      scope: 'ORGANISATION', stripeCustomerId: remote.customer } });
    const checkout = await p.billingStripeCheckoutSession.create({ data: { accountId: acct.id, appKeyId: key.id,
      customerId: customer.id, serviceId: service.id, tariffId: tariff.id, tariffSource: 'SERVICE_DEFAULT',
      orgId: org.id, scope: 'ORGANISATION', scopeKey: org.id, actorJti: 'replay', requestedByUserId: owner.id,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date() } });
    // The provider-only evaluation created the original subscription; seed that explicit binding
    // here. The PostgreSQL membership evaluation separately tests the normal Checkout projection.
    await p.billingStripeSubscription.create({ data: { accountId: acct.id, checkoutId: checkout.id, customerId: customer.id,
      serviceId: service.id, tariffId: tariff.id, tariffSource: 'SERVICE_DEFAULT', orgId: org.id, scope: 'ORGANISATION',
      scopeKey: org.id, stripeSubscriptionId: remote.id, stripeMonthlyItemId: item.id,
      stripeUsageItemId: remote.items.data.find((row: Stripe.SubscriptionItem) => row.price.recurring?.usage_type === 'metered')?.id ?? 'fixture_unused_meter',
      status: remote.status, livemode: false } });
    for (const id of ids) {
      const prepared = await prepareStripePaymentInvoice(id, acct, p, provider);
      if (!prepared) {
        const invoice = get('/v1/invoices/' + id);
        assert.equal(invoice.parent?.subscription_details?.subscription, remote.id); assert.equal(invoice.customer, remote.customer);
        assert.equal(invoice.amount_paid, 0); assert.equal(invoice.amount_due, 0);
        console.log(JSON.stringify({ id, deferredMinor: invoice.total })); continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) await p.$transaction(tx => persistStripePaymentInvoice(tx, prepared));
      const rows = await p.billingStripePaymentInvoice.findMany({ where: { stripeInvoiceId: id }, include: { cashPayments: true, lines: true } });
      assert.equal(rows.length, 1); const row = rows[0]; assert.ok(row);
      assert.equal(row.paidAmountMinor, BigInt(prepared.invoice.amount_paid));
      assert.equal(row.lines.reduce((sum, line) => sum + line.dueMinor, 0n), row.dueAmountMinor);
      assert.equal(row.cashPayments.reduce((sum, cash) => sum + cash.amountMinor, 0n), row.paidAmountMinor);
      console.log(JSON.stringify({ id, currency: row.currency, paidMinor: row.paidAmountMinor.toString(), cashPayments: row.cashPayments.length,
        lines: row.lines.length, priorQuantityOffsets: row.lines.filter(line => line.offsetStripeLineId).length,
        carried: row.lines.filter(line => line.carriedFromStripeInvoiceId).length }));
    }
  } finally { await db.cleanup(); }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Receipt verification failed'); process.exitCode = 1; });

