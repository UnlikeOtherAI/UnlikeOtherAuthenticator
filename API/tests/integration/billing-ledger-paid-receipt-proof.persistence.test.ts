import { createHash, randomUUID } from 'node:crypto';

import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  matchUoaPaidReceiptSet, verifyLedgerPaidReceiptSet,
  type LedgerPaidReceiptSet,
} from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!enabled)('signed paid receipt cohort', () => {
  let db: TestDb;
  let keys: ReturnType<typeof createLocalJWKSet>;
  let signer: CryptoKey;
  const scope = { product: `proof-${randomUUID()}`, organisationId: randomUUID(),
    teamId: randomUUID(), serviceId: randomUUID(), billingMonth: '2026-09' };
  const paidRows = [
    { dispatchId: `d-${randomUUID()}`, receiptId: `r-${randomUUID()}`,
      rawCost: '0.000000000000000000', ratedMicrocredits: 0n },
    { dispatchId: `d-${randomUUID()}`, receiptId: `r-${randomUUID()}`,
      rawCost: '1.000000000000000000', ratedMicrocredits: 1_300_000_000n },
  ].sort((a, b) => Buffer.compare(Buffer.from(a.dispatchId), Buffer.from(b.dispatchId)));

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const pair = await generateKeyPair('RS256');
    signer = pair.privateKey as CryptoKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)),
      kid: 'ledger-test', alg: 'RS256', use: 'sig' }] });
    for (const row of paidRows) {
      await db.prisma.billingPaidUsageLiability.create({ data: {
        dispatchId: row.dispatchId, receiptId: row.receiptId,
        serviceId: scope.serviceId, providerServiceId: 'provider-model',
        orgId: scope.organisationId, teamId: scope.teamId, userId: randomUUID(),
        billingMonth: scope.billingMonth, currency: 'USD', tariffId: randomUUID(),
        frozenMarkupBps: 3000, paymentMode: 'PAY_AS_YOU_GO',
        rawCostActual: row.rawCost, ratedQuanta: '0',
        ratedMicrocredits: row.ratedMicrocredits,
      } });
    }
  });

  afterAll(async () => { await db?.cleanup(); });

  async function proof(overrides: Record<string, unknown> = {}): Promise<LedgerPaidReceiptSet> {
    const digest = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
    for (const row of paidRows) {
      digest.update(JSON.stringify([row.dispatchId, row.receiptId, row.rawCost])).update('\n');
    }
    const body = { contract: 'ledger-paid-receipt-set-v1',
      scope: { billing_product: scope.product, organization_id: scope.organisationId,
        team_id: scope.teamId, billing_month: scope.billingMonth },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
        captured_at: '2026-10-01T00:00:00.000Z', immutable: true },
      paid_receipt_count: String(paidRows.length), paid_receipt_sha256: digest.digest('hex'),
      zero_incremental_count: '0',
      zero_incremental_sha256: createHash('sha256')
        .update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0', ...overrides };
    const signature = await new CompactSign(Buffer.from(JSON.stringify(body)))
      .setProtectedHeader({ alg: 'RS256', typ: 'ledger-paid-receipt-set+jws',
        kid: 'ledger-test' }).sign(signer);
    return { ...body, signature } as LedgerPaidReceiptSet;
  }

  it('verifies signed scope and exact paid receipt identities, including zero cost', async () => {
    const signed = await verifyLedgerPaidReceiptSet(await proof(), scope, keys);
    const matched = await matchUoaPaidReceiptSet(db.prisma, scope, signed);
    expect(matched).toMatchObject({ ratedMicrocredits: 1_300_000_000n,
      receiptCount: 2 });
    await expect(verifyLedgerPaidReceiptSet({ ...signed, paid_receipt_count: '0' },
      scope, keys)).rejects.toThrow('LEDGER_PAID_RECEIPT_SET_SCOPE_INVALID');
    await expect(verifyLedgerPaidReceiptSet(await proof({ unresolved_paid_attempts: '1' }),
      scope, keys)).rejects.toThrow('LEDGER_PAID_RECEIPT_SET_UNRESOLVED');
  });

  it('holds a missing or altered local receipt despite equal aggregate money', async () => {
    const signed = await verifyLedgerPaidReceiptSet(await proof(), scope, keys);
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId: randomUUID(), receiptId: randomUUID(),
      serviceId: scope.serviceId, providerServiceId: 'provider-model',
      orgId: scope.organisationId, teamId: scope.teamId, userId: randomUUID(),
      billingMonth: scope.billingMonth, currency: 'USD', tariffId: randomUUID(),
      frozenMarkupBps: 3000, paymentMode: 'PAY_AS_YOU_GO',
      rawCostActual: '0', ratedQuanta: '0', ratedMicrocredits: 0n,
    } });
    await expect(matchUoaPaidReceiptSet(db.prisma, scope, signed))
      .rejects.toThrow('BILLING_CYCLE_RECEIPT_SET_MISMATCH');
  });
});
