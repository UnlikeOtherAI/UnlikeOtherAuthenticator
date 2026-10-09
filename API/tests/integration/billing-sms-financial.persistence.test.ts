import { vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedSmsFinance, smsCredential, smsIds, smsReceiptProvider, smsStanding } from
  '../helpers/sms-financial-fixture.js';
import { settleSmsInbound } from '../../src/services/billing-sms-inbound.service.js';
import { readSmsStanding } from '../../src/services/billing-sms-standing.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
const message = (digit: string) => `SM${digit.repeat(32)}`;
function incoming(allocation: string, digit: string, amount: string | null, segments: string | null = '1') {
  return settleSmsInbound({ credential: smsCredential, request: { product: 'nessie', number_id: smsIds.number,
    allocation_id: allocation, organisation_id: smsIds.org, team_id: smsIds.team, message_sid: message(digit) } },
  { prisma, provider: smsReceiptProvider(amount, segments) });
}

describe.skipIf(!process.env.DATABASE_URL)('SMS financial PostgreSQL invariants', () => {
  beforeAll(async () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '7.25');
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '2700');
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required for financial verification');
    prisma = db.prisma; cleanup = db.cleanup;
    await seedSmsFinance(prisma);
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('prevents rewriting accepted commercial terms', async () => {
    await expect(prisma.billingSmsQuote.update({ where: { id: smsIds.quote },
      data: { messageMarkupBps: 4100 } })).rejects.toThrow('SMS accepted commercial policy is immutable');
  });

  it('settles funded inbound against the canonical wallet and immutable runtime provenance once', async () => {
    const hold = await smsStanding(prisma, 'funded', 20_000_000n);
    expect(await incoming('funded', '1', '0.01')).toEqual({ message_sid: message('1'), state: 'funded',
      consumed_credits: '12.700000', uncollected_credits: null });
    expect(await incoming('funded', '1', '0.01')).toMatchObject({ state: 'funded', consumed_credits: '12.700000' });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } })).balanceMicrocredits)
      .toBe(87_300_000n);
    expect((await prisma.billingSmsStandingHold.findUniqueOrThrow({ where: { id: hold.id } })).reservedMicrocredits)
      .toBe(7_300_000n);
    const entries = await prisma.billingCreditEntry.findMany({ where: { smsInboundReceiptId: { not: null } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'SMS_PREPAID_USAGE', sourceType: 'sms_inbound_receipt',
      appKeyId: smsIds.runtime, amountMicrocredits: 12_700_000n });
    await expect(prisma.billingCreditEntry.update({ where: { id: entries[0]!.id }, data: { amountMicrocredits: 1n } }))
      .rejects.toThrow();
  });

  it('keeps unknown and above-authorized incoming charges outside wallet debits', async () => {
    await smsStanding(prisma, 'bounded', 20_000_000n);
    expect(await incoming('bounded', '2', null)).toMatchObject({ state: 'pending', consumed_credits: null });
    expect(await incoming('bounded', '3', '0.02')).toMatchObject({ state: 'reconciliation', consumed_credits: null });
    expect(await incoming('bounded', '4', '0.01', null)).toMatchObject({ state: 'reconciliation', consumed_credits: null });
    expect(await incoming('unfunded', '5', '0.01')).toMatchObject({ state: 'uncollected',
      uncollected_credits: null, consumed_credits: null });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } })).balanceMicrocredits)
      .toBe(87_300_000n);
    await expect(incoming('other-allocation', '1', '0.01')).rejects.toThrow('BILLING_SMS_INBOUND_BINDING_CONFLICT');
  });

  it('fences missing standing retirement and preserves held funds for historical unknown usage', async () => {
    expect(await readSmsStanding({ credential: smsCredential, retire: true, request: {
      product: 'nessie', number_id: smsIds.number, allocation_id: 'retired-before-fund',
    } }, { prisma })).toEqual({ number_id: smsIds.number, allocation_id: 'retired-before-fund',
      state: 'retired', can_fund: false });
    await expect(smsStanding(prisma, 'retired-before-fund', 1n)).rejects.toThrow('SMS standing allocation was retired');
    const hold = await smsStanding(prisma, 'late', 1_000_000n);
    await readSmsStanding({ credential: smsCredential, retire: true, request: {
      product: 'nessie', number_id: smsIds.number, allocation_id: 'late',
    } }, { prisma });
    expect((await prisma.billingSmsStandingHold.findUniqueOrThrow({ where: { id: hold.id } })).reservedMicrocredits)
      .toBe(1_000_000n);
    await expect(prisma.billingSmsStandingHold.update({ where: { id: hold.id }, data: { reservedMicrocredits: 2_000_000n } }))
      .rejects.toThrow();
  });

  it('rejects a combined multi-row SQL hold above balance even when each row fits alone', async () => {
    await expect(prisma.$executeRaw(Prisma.sql`INSERT INTO billing_sms_standing_holds
      (id,credit_account_id,service_id,app_key_id,org_id,team_id,number_id,allocation_id,quote_id,
       requested_by_user_id,idempotency_key,reserved_microcredits,updated_at)
      SELECT 'bulk-'||x,${smsIds.credit},${smsIds.service},${smsIds.lifecycle},${smsIds.org},${smsIds.team},
        ${smsIds.number},'bulk-'||x,${smsIds.quote},${smsIds.user},'bulk-'||x,40000000,CURRENT_TIMESTAMP
      FROM generate_series(1,2) x`)).rejects.toThrow('insufficient available prepaid credits');
    expect(await prisma.billingSmsStandingHold.count({ where: { allocationId: { startsWith: 'bulk-' } } })).toBe(0);
  });

  it('serializes overlapping reservations against one shared balance with a real transaction barrier', async () => {
    let unblock!: () => void;
    let acquired!: () => void;
    const firstLocked = new Promise<void>((resolve) => { acquired = resolve; });
    const barrier = new Promise<void>((resolve) => { unblock = resolve; });
    const first = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_credit_accounts WHERE id=${smsIds.credit} FOR UPDATE`);
      acquired(); await barrier;
      return tx.billingSmsStandingHold.create({ data: { creditAccountId: smsIds.credit, serviceId: smsIds.service,
        appKeyId: smsIds.lifecycle, orgId: smsIds.org, teamId: smsIds.team, numberId: smsIds.number,
        allocationId: 'race-one', quoteId: smsIds.quote, requestedByUserId: smsIds.user,
        idempotencyKey: 'race-one', reservedMicrocredits: 40_000_000n } });
    });
    await firstLocked;
    const second = smsStanding(prisma, 'race-two', 40_000_000n);
    unblock();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await prisma.billingSmsStandingHold.count({ where: { allocationId: { in: ['race-one', 'race-two'] } } })).toBe(1);
  });

  it('rejects changing frozen refund proof or completing refund recovery without verified evidence', async () => {
    await prisma.billingSmsNumberResource.update({ where: { id: smsIds.number }, data: { state: 'refund_required' } });
    await expect(prisma.billingSmsNumberResource.update({ where: { id: smsIds.number }, data: { state: 'ended' } }))
      .rejects.toThrow();
    await prisma.billingSmsNumberResource.update({ where: { id: smsIds.number }, data: {
      state: 'ended', refundEvidenceDigest: 'c'.repeat(64), refundedAt: new Date(),
    } });
    await expect(prisma.billingSmsNumberResource.update({ where: { id: smsIds.number },
      data: { refundEvidenceDigest: 'd'.repeat(64) } })).rejects.toThrow();
  });
});
