import { randomUUID } from 'node:crypto';

import {
  BillingCreditPaymentInvoiceSource,
  BillingCreditPaymentInvoiceState,
  type BillingCreditPaymentInvoice,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCreditPaymentInvoiceCycle } from '../../src/services/billing-credit-payment-invoice-scheduler.service.js';
import type { issueCreditPaymentInvoice } from '../../src/services/billing-credit-payment-invoice-issue.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  fundingRaceIds as ids, seedFundingRace,
} from './billing-credit-funding-actions.persistence.fixture.js';

const prefix = randomUUID().slice(0, 8);
const now = new Date('2026-10-04T18:00:00.000Z');

describe.skipIf(!process.env.DATABASE_URL)('prepaid invoice retry queue PostgreSQL fairness', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL required');
    await seedFundingRace(handle.prisma);
    // The fixture supplies already-accepted payment obligations so this test
    // isolates the real PostgreSQL due/claim schedule from funding provenance.
    // The separate webhook test exercises production funding triggers end to end.
    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingCreditPaymentInvoice.createMany({
        data: Array.from({ length: 51 }, (_, index) => {
          const suffix = `${prefix}_${String(index + 1).padStart(3, '0')}`;
          return {
            id: `queue_${suffix}`,
            accountId: ids.account,
            livemode: false,
            stripePaymentIntentId: `pi_queue_${suffix}`,
            stripeChargeId: `ch_queue_${suffix}`,
            source: BillingCreditPaymentInvoiceSource.MANUAL_TOP_UP,
            topUpCheckoutId: `checkout_queue_${suffix}`,
            creditEntryId: `entry_queue_${suffix}`,
            creditAccountId: ids.creditAccount,
            serviceId: ids.service,
            appKeyId: ids.appKey,
            orgId: ids.org,
            teamId: ids.team,
            attributedUserId: ids.user,
            stripeCustomerId: 'cus_funding_race',
            currency: 'USD',
            grossAmountMinor: 500n,
            creditsPurchasedMicrocredits: 5_000_000_000n,
            paidAt: new Date('2026-08-31T23:59:58.000Z'),
            nextIssueAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
          };
        }),
      });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
    });
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('defers 50 failures durably and lets the 51st advance across workers', async () => {
    const provider = {
      accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: 'acct_funding_race' }) },
    } as never;
    const failedIssue = vi.fn().mockRejectedValue(
      new Error('provider temporarily unavailable'),
    ) as typeof issueCreditPaymentInvoice;
    const first = await runCreditPaymentInvoiceCycle({
      prisma: handle!.prisma, stripe: provider, livemode: false,
      issue: failedIssue, now: () => now,
    });
    expect(first.attempted).toBe(50);
    expect(first.failures).toHaveLength(50);
    const remaining = await handle!.prisma.billingCreditPaymentInvoice.findMany({
      where: { accountId: ids.account },
      orderBy: { id: 'asc' },
    });
    expect(remaining).toHaveLength(51);
    expect(remaining.slice(0, 50).every((row) => row.issueAttemptCount === 1 &&
      row.nextIssueAttemptAt > now && row.lastIssueError ===
        'BILLING_CREDIT_INVOICE_ISSUE_FAILED')).toBe(true);
    expect(remaining[50]?.issueAttemptCount).toBe(0);

    const healthyId = remaining[50]?.id;
    const healthyIssue = vi.fn(async (id: string) => {
      expect(id).toBe(healthyId);
      return { state: BillingCreditPaymentInvoiceState.ISSUED } as BillingCreditPaymentInvoice;
    }) as typeof issueCreditPaymentInvoice;
    // These fresh runner invocations share only PostgreSQL state. SKIP LOCKED
    // claims disjoint work even when two scheduler instances race after restart.
    const [second, third] = await Promise.all([0, 1].map(() =>
      runCreditPaymentInvoiceCycle({
        prisma: handle!.prisma, stripe: provider, livemode: false,
        issue: healthyIssue, now: () => now,
      })));
    expect(second.attempted + third.attempted).toBe(1);
    expect(second.issued + third.issued).toBe(1);
    expect(healthyIssue).toHaveBeenCalledTimes(1);
  }, 30_000);
});
