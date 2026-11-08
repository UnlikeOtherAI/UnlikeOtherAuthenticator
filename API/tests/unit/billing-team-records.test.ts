import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { readTeamRecordedUsage, readTeamRetainedCredits } from '../../src/services/billing-team-records.service.js';
import type { LedgerPaidReceiptSet } from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';
const scope = { product: 'nessie', organisationId: 'org', teamId: 'team', billingMonth: '2026-11', serviceId: 'service' };
const proof = { scope: { billing_product: 'nessie', organization_id: 'org', team_id: 'team', billing_month: '2026-11' },
  unresolved_paid_attempts: '0', snapshot: { immutable: true, captured_at: '2026-11-08T00:00:00Z' }, paid_receipt_count: '1',
  paid_receipt_sha256: createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n')
    .update(JSON.stringify(['dispatch', 'receipt', '0.100000000000000000'])).update('\n').digest('hex') } as LedgerPaidReceiptSet;
const usage = { billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
  lines: [{ billingDisposition: 'paid', currency: 'USD', selectedProviderCost: '0.1' }] } as NormalizedMeteringUsage;
const captured = { dispatch_id: 'dispatch', receipt_id: 'receipt', rated: 100000000n, currency: 'USD',
  account_id: 'captured-account', livemode: false, valid: true, exception_valid: true, waived: null };
function reader(row = captured) {
  return { billingPaidUsageLiability: { findMany: vi.fn().mockResolvedValue([{ dispatchId: 'dispatch', receiptId: 'receipt',
    rawCostActual: new Prisma.Decimal('0.1'), ratedMicrocredits: 100000000n, paymentMode: 'PAY_AS_YOU_GO' }]) },
  billingCreditBudgetLegacyLiability: { findMany: vi.fn().mockResolvedValue([]) },
  billingPrepaidReservation: { findMany: vi.fn().mockResolvedValue([]) },
  $queryRaw: vi.fn().mockResolvedValue([row]) } as unknown as PrismaClient;
}
describe('read-only captured team records', () => {
  it('attributes immutable usage only to its captured source without selecting a current mode', async () => {
    const value = await readTeamRecordedUsage(reader(), scope, usage, proof);
    expect(value.sources).toHaveLength(1);expect(value.sources[0]).toMatchObject({ mode: 'sandbox', recorded_usage: { credits: '100' } });
    expect(JSON.stringify(value)).not.toContain('captured-account');
  });
  it('holds unknown accounts, contradictory bindings, currencies and unresolved waivers', async () => {
    for (const row of [{ ...captured, account_id: null }, { ...captured, valid: false },
      { ...captured, currency: 'EUR' }, { ...captured, exception_valid: false }, { ...captured, livemode: null }]) {
      await expect(readTeamRecordedUsage(reader(row as never), scope, usage, proof)).rejects.toThrow('BILLING_TEAM_RECORDS_RECONCILIATION_REQUIRED');
    }
  });
  it('holds wrong-scope proofs, unresolved cohorts and raw-cost mismatch', async () => {
    await expect(readTeamRecordedUsage(reader(), scope, usage,
      { ...proof, scope: { ...proof.scope, team_id: 'foreign' } })).rejects.toThrow('BILLING_TEAM_RECORDS_RECONCILIATION_REQUIRED');
    await expect(readTeamRecordedUsage(reader(), scope, usage, { ...proof, unresolved_paid_attempts: '1' }))
      .rejects.toThrow('BILLING_TEAM_RECORDS_RECONCILIATION_REQUIRED');
    await expect(readTeamRecordedUsage(reader(), scope, { ...usage, lines: [] }, proof))
      .rejects.toThrow('BILLING_TEAM_RECORDS_RECONCILIATION_REQUIRED');
  });
  it('filters retained history to the exact TEAM scope and never opens a new wallet', async () => {
    const findMany = vi.fn().mockResolvedValue([]), now = new Date();
    const value = await readTeamRetainedCredits({ billingCreditAccount: { findMany } } as never, 'org', 'team', now);
    expect(value.records).toEqual([]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: 'org', teamId: 'team', scope: 'TEAM' }, take: 101 }));
  });
});
