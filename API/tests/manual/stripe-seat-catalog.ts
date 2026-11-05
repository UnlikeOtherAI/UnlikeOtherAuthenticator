import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createTestDb } from '../helpers/test-db.js';
import { sandboxCliClient } from './stripe-cli-sandbox.js';
import { provisionNessieSeatCatalog } from '../../src/services/billing-nessie-seat-catalog.service.js';

const [expected, flag, existing] = process.argv.slice(2);
assert.equal(flag, '--create-test-data');
if (existing) assert.match(existing, /^test_[0-9]+_[a-f0-9]{32}$/);
const stripe = sandboxCliClient(expected!);
const seats = { USD: 399, GBP: 299, EUR: 299 };
const name = 'Nessie sandbox tariff review';
async function run() {
  const db = existing ? null : await createTestDb();
  const schema = existing ?? db?.schema;
  assert.ok(schema);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', schema);
  const p = db?.prisma ?? new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    if (!existing) {
      const service = await p.billingService.create({ data: { identifier: 'nessie', name } });
      await p.billingStripeAccount.create({ data: { stripeAccountId: expected!, livemode: false } });
      for (const [currency, minor] of Object.entries(seats)) await p.billingTariff.create({ data: {
        serviceId: service.id, key: 'standard-' + currency.toLowerCase(), name: 'Standard ' + currency, currency,
        version: 1, mode: 'STANDARD', collectionMode: 'STRIPE', monthlyAmountMinor: BigInt(minor), markupBps: 3000,
        monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED', usagePaymentMode: 'PREPAID' } });
    }
    assert.equal((await p.billingService.findUniqueOrThrow({ where: { identifier: 'nessie' } })).name, name);
    console.log(JSON.stringify({ step: 'review_schema', schema, account: expected }));
    const input = { stripe, prisma: p, expectedStripeAccountId: expected!, expectedLivemode: false };
    const before = await p.billingTariff.count();
    const preview = await provisionNessieSeatCatalog({ ...input, dryRun: true });
    assert.equal(preview.plans.length, 3); assert.equal(await p.billingTariff.count(), before);
    const applied = await provisionNessieSeatCatalog({ ...input, dryRun: false });
    const replay = await provisionNessieSeatCatalog({ ...input, dryRun: false });
    assert.deepEqual(replay.plans, applied.plans); assert.equal(await p.billingTariff.count(), 6);
    for (const plan of applied.plans) {
      assert.ok(plan.priceId); assert.equal(plan.version, 2);
      assert.equal(plan.anniversarySeats, true);
      const price = await stripe.prices.retrieve(plan.priceId);
      assert.equal(price.active, true); assert.equal(price.livemode, false);
      assert.equal(price.currency, plan.currency.toLowerCase()); assert.equal(price.unit_amount, seats[plan.currency as keyof typeof seats]);
      assert.equal(price.recurring?.interval, 'month'); assert.equal(price.recurring.interval_count, 1);
      assert.equal(price.recurring.usage_type, 'licensed');
      console.log(JSON.stringify({ ...plan, interval: 'month', usageType: 'licensed', taxBehavior: price.tax_behavior }));
    }
  } finally { await p.$disconnect(); }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Catalog evaluation failed'); process.exitCode = 1; });

