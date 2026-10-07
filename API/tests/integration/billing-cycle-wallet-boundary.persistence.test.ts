import { randomUUID } from 'node:crypto';

import { BillingAssignmentScope, Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readCycleWalletBoundary } from '../../src/services/billing-cycle-wallet-boundary.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!enabled)('funded wallet UTC boundary proof', () => {
  let db: TestDb;
  let orgId: string;
  let teamId: string;
  let creditAccountId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const user = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: `${randomUUID()}@example.com`,
      name: 'Boundary owner',
    } });
    const org = await db.prisma.organisation.create({ data: {
      domain: `${randomUUID()}.example.com`, name: 'Boundary org',
      slug: `boundary-${randomUUID().slice(0, 10)}`, ownerId: user.id,
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId,
      name: 'Boundary team', slug: `team-${randomUUID().slice(0, 10)}` } });
    teamId = team.id;
    const stripe = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false,
    } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: stripe.id, orgId, teamId, scope: BillingAssignmentScope.TEAM,
      scopeKey: `${orgId}:${teamId}`,
    } });
    const account = await db.prisma.billingCreditAccount.create({ data: {
      accountId: stripe.id, customerId: customer.id, orgId, teamId,
      scope: BillingAssignmentScope.TEAM, scopeKey: `${orgId}:${teamId}`,
      currency: 'USD',
    } });
    creditAccountId = account.id;
  });

  afterAll(async () => { await db?.cleanup(); });

  const october = { startsAt: new Date('2026-10-01T00:00:00.000Z'),
    endsAt: new Date('2026-11-01T00:00:00.000Z') };
  async function boundary() {
    return readCycleWalletBoundary(db.prisma, { orgId, teamId,
      payer: BillingAssignmentScope.TEAM, ...october });
  }

  // This fixture simulates already verified immutable funding entries. Trigger
  // suspension is LOCAL to one disposable-DB transaction; no shared DB state
  // or production financial record is touched.
  async function importedEntry(occurredAt: Date, direction: 'CREDIT' | 'DEBIT',
    amount: bigint) {
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const account = await tx.billingCreditAccount.findUniqueOrThrow({
        where: { id: creditAccountId },
      });
      const next = account.balanceMicrocredits +
        (direction === 'CREDIT' ? amount : -amount);
      await tx.$executeRaw(Prisma.sql`INSERT INTO billing_credit_entries
        (id, credit_account_id, direction, kind, amount_microcredits,
          balance_after_microcredits, currency, idempotency_key, source_type,
          source_id, occurred_at)
        VALUES (${randomUUID()}, ${creditAccountId},
          ${direction}::"BillingCreditEntryDirection", 'ADJUSTMENT'::"BillingCreditEntryKind",
          ${amount}, ${next}, 'USD', ${randomUUID()},
          'credit_admin_adjustment', ${randomUUID()}, ${occurredAt})`);
      await tx.billingCreditAccount.update({ where: { id: creditAccountId },
        data: { balanceMicrocredits: next } });
    });
  }

  it('freezes a month by effect time and revises only for late backdated entries', async () => {
    expect(await boundary()).toMatchObject({ status: 'confirmed',
      opening_microcredits: '0', closing_microcredits: '0' });
    await importedEntry(new Date('2026-10-02T00:00:00.000Z'), 'CREDIT', 100n);
    await importedEntry(new Date('2026-10-20T00:00:00.000Z'), 'DEBIT', 10n);
    const first = await boundary();
    expect(first).toMatchObject({ status: 'confirmed',
      opening_microcredits: '0', closing_microcredits: '90', entry_count: '2' });
    await importedEntry(new Date('2026-11-15T00:00:00.000Z'), 'CREDIT', 50n);
    expect((await boundary()).fingerprint).toBe(first.fingerprint);
    await importedEntry(new Date('2026-10-31T23:59:59.000Z'), 'DEBIT', 10n);
    const revised = await boundary();
    expect(revised).toMatchObject({ status: 'confirmed',
      opening_microcredits: '0', closing_microcredits: '80', entry_count: '3' });
    expect(revised.fingerprint).not.toBe(first.fingerprint);
    expect(await readCycleWalletBoundary(db.prisma, { orgId, teamId,
      payer: BillingAssignmentScope.ORGANISATION, ...october }))
      .toMatchObject({ status: 'pending_reconciliation', opening_microcredits: null });
  });
});
