import { createTestCapturedPaidLiability } from '../helpers/organisation-financial-binding.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { manualInvoiceReservedMicroMinor } from '../../src/services/billing-credit-manual-invoice-cap.service.js';
import { calculateBillingContractInvoice } from '../../src/services/billing-invoice-calculation.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';

import { afterPayerLock, deferred, waitForPayerWait } from '../helpers/manual-invoice-payer-race.js';

import { month, endsAt, MemoryStorage, db, credential, ids, proof, usage, portfolio } from './billing-credit-manual-invoice-cap.suite-fixture.js';

export function registerCases1() {
  it('keeps a late top-up off invoiced receipts but funds new paid receipts', async () => {
    const fundingId = randomUUID();
    const entryId = randomUUID();
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config(
        'app.admin_auth_domain', ${getAdminAuthDomain()}, true)`);
      await tx.billingCreditAdminAdjustment.create({ data: {
        id: fundingId, accountId: ids.account, creditAccountId: ids.creditAccount,
        orgId: ids.org, teamId: null, signedAmountMicrocredits: 2_600_000_000n,
        reason: 'Late top-up fixture', idempotencyKey: fundingId,
        createdByUserId: ids.user, createdByEmail: ids.userEmail,
        createdByAdminDomain: getAdminAuthDomain(), creditEntryId: entryId,
      } });
      await tx.billingCreditEntry.create({ data: {
        id: entryId, creditAccountId: ids.creditAccount, direction: 'CREDIT',
        kind: 'ADJUSTMENT', amountMicrocredits: 2_600_000_000n,
        balanceAfterMicrocredits: 2_600_000_000n, currency: 'USD',
        idempotencyKey: fundingId, sourceType: 'credit_admin_adjustment',
        sourceId: fundingId, occurredAt: new Date('2030-09-04T00:00:01.000Z'),
      } });
    });
    await settleCreditPortfolio({ creditAccountId: ids.creditAccount,
      credential, portfolio: portfolio('mup_manual_old_12345678901234567',
        '1', '2030-09-04T00:01:00.000Z') }, { prisma: db.prisma });
    const first = await db.prisma.billingCreditUsageSettlement.findFirstOrThrow({ where: {
      creditAccountId: ids.creditAccount, billingMonth: month, serviceId: ids.service,
    } });
    expect(first.cumulativeCreditsConsumedMicrocredits).toBe(0n);
    await createTestCapturedPaidLiability(db.prisma,{ data: {
      dispatchId: `dispatch-${randomUUID()}`, receiptId: `receipt-${randomUUID()}`,
      serviceId: ids.service, providerServiceId: 'provider-test', orgId: ids.org,
      teamId: ids.team, userId: ids.user, billingMonth: month,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    await settleCreditPortfolio({ creditAccountId: ids.creditAccount,
      credential, portfolio: portfolio('mup_manual_new_12345678901234567',
        '2', '2030-09-04T00:02:00.000Z') }, { prisma: db.prisma });
    const second = await db.prisma.billingCreditUsageSettlement.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(second.cumulativeCreditsConsumedMicrocredits).toBe(1_300_000_000n);
    expect((await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: {
      id: ids.creditAccount,
    } })).balanceMicrocredits).toBe(1_300_000_000n);
  });

  it('holds a missing historical cohort instead of guessing a team share', async () => {
    const original = await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
      id: ids.invoice,
    } });
    await db.prisma.billingInvoice.update({ where: { id: original.id }, data: {
      status: 'VOID', voidedAt: new Date('2030-09-05T00:00:00.000Z'),
      voidReason: 'Fixture moves collection authority to legacy invoice',
    } });
    const secondTeam = await db.prisma.team.create({ data: {
      orgId: ids.org, name: 'Other source team',
      slug: `other-${randomUUID().slice(0, 10)}`,
    } });
    await createTestCapturedPaidLiability(db.prisma,{ data: {
      dispatchId: `dispatch-${randomUUID()}`, receiptId: `receipt-${randomUUID()}`,
      serviceId: ids.service, providerServiceId: 'provider-test', orgId: ids.org,
      teamId: secondTeam.id, userId: ids.user, billingMonth: month,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    // Simulate a legacy issued organisation line with no per-dispatch
    // manifest. Its amount could belong to either source team.
    const legacy = await db.prisma.billingInvoice.create({ data: {
      orgId: original.orgId, contractId: original.contractId,
      contractVersionId: original.contractVersionId,
      issuerProfileId: original.issuerProfileId,
      buyerProfileId: original.buyerProfileId,
      billingMonth: month, revision: original.revision + 1,
      currency: 'USD', subtotalMinor: 130n, taxAmountMinor: 0n,
      totalMinor: 130n, taxTreatment: 'NO_TAX_CHARGED', taxRateBps: 0,
      taxLegalBasis: 'Fixture tax treatment',
      issuerSnapshot: original.issuerSnapshot as Prisma.InputJsonValue,
      buyerSnapshot: original.buyerSnapshot as Prisma.InputJsonValue,
      calculationDigest: 'b'.repeat(64),
      lines: { create: { serviceId: ids.service,
        serviceIdentifier: credential.service.identifier,
        serviceName: credential.service.name,
        amountMinor: 130n, currency: 'USD', position: 1 } },
      meteringRefs: { create: { serviceId: ids.service,
        ledgerSnapshotCursor: 'legacy-unknown-source-team',
        ledgerSnapshotSha256: 'c'.repeat(64), capturedAt: new Date(endsAt) } },
    }, include: { lines: true } });
    const line = legacy.lines[0];
    if (!line) throw new Error('LEGACY_LINE_MISSING');
    await db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId: line.id, invoiceId: legacy.id, serviceId: ids.service,
      billingMonth: month, subscriptionMinor: 0n, usageMinor: 130n,
      taxMinor: 0n, invoiceCreditMinor: 0n, totalMinor: 130n,
      dueMinor: 130n, currency: 'USD', calculationDigest: legacy.calculationDigest,
    } });
    // A populated pre-194600 invoice may already be in ISSUING. Direct
    // historical state simulation tests the new collector without pretending
    // the current issuer would authorize a missing manifest.
    await db.prisma.billingInvoice.update({ where: { id: legacy.id }, data: {
      status: 'ISSUING', invoiceNumber: `LEGACY-${randomUUID()}`,
      issueDate: new Date('2030-09-05T00:00:00.000Z'),
      dueDate: new Date('2030-10-05T00:00:00.000Z'),
    } });
    await expect(db.prisma.$transaction((tx) => manualInvoiceReservedMicroMinor(tx, {
      orgId: ids.org, teamId: ids.team, serviceId: ids.service,
      billingMonth: month, creditAccountId: ids.creditAccount,
    }))).rejects.toThrow('BILLING_CREDIT_MANUAL_INVOICE_COHORT_UNPROVEN');
  });

  it('rejects a stale draft when concurrent wallet settlement wins the payer lock', async () => {
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    const september = '2030-09';
    await createTestCapturedPaidLiability(db.prisma,{ data: {
      dispatchId, receiptId, serviceId: ids.service, providerServiceId: 'provider-test',
      orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: september,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    const starts = '2030-09-01T00:00:00.000Z';
    const ends = '2030-10-01T00:00:00.000Z';
    const product = credential.service.identifier;
    const digest = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n')
      .update(JSON.stringify([dispatchId, receiptId, '1.000000000000000000']))
      .update('\n').digest('hex');
    const septemberProof = { ...proof(product),
      scope: { billing_product: product, organization_id: ids.org,
        team_id: ids.team, billing_month: september },
      snapshot: { cursor: `mpr_${'b'.repeat(32)}`, captured_at: ends,
        immutable: true as const },
      paid_receipt_count: '1', paid_receipt_sha256: digest };
    const septemberUsage = { ...usage(product), scope: {
      organizationId: ids.org, teamId: null, userId: null,
      month: september, startsAt: starts, endsAt: ends },
      snapshot: { id: 'september-manual', cursor: 'september-manual',
        capturedAt: ends, immutable: true, sha256: 'b'.repeat(64) } };
    const draft = await calculateBillingContractInvoice({
      contractId: ids.contract, issuerProfileId: (await db.prisma.billingInvoice.findUniqueOrThrow({
        where: { id: ids.invoice } })).issuerProfileId,
      billingMonth: september,
      taxTerms: { treatment: 'NO_TAX_CHARGED', rateBps: 0,
        legalBasis: 'Fixture tax treatment' }, actor: { email: 'operator@example.test' },
    }, { prisma: db.prisma, fetchMetering: async () => septemberUsage,
      collectFunding: vi.fn().mockResolvedValue({ credits: [], addons: [] }),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [ids.team], snapshot: {
        id: 'september-team', cursor: 'september-team', capturedAt: ends,
        sha256: 'b'.repeat(64) } }),
      fetchPaidReceiptSet: async () => septemberProof,
      now: () => new Date('2030-10-03T00:00:00.000Z'),
    });
    const settlementClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const issueClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const locked = deferred();
    const unlock = deferred();
    const pending:Promise<unknown>[]=[];let blockingPid=0;
    try {
      const SeptemberPortfolio = { ...portfolio('mup_manual_race_12345678901234567',
        '1', '2030-10-03T00:01:00.000Z'),
      scope: { organizationId: ids.org, teamId: ids.team, month: september,
        startsAt: starts, endsAt: ends } };
      const settlement = settleCreditPortfolio({ creditAccountId: ids.creditAccount,
        credential, portfolio: SeptemberPortfolio }, {
        prisma: afterPayerLock(settlementClient, async tx => {
          blockingPid=(await tx.$queryRaw<Array<{pid:number}>>(Prisma.sql`SELECT pg_backend_pid() AS pid`))[0]?.pid??0;
          locked.release();
          await unlock.promise;
        }),
      });
      pending.push(settlement);void settlement.catch(()=>{});
      await Promise.race([locked.promise,settlement.then(()=>{throw Error('Settlement completed before lock');})]);
      const issue = issueBillingInvoice({ invoiceId: draft.id,
        actor: { email: 'operator@example.test' } }, {
        prisma: issueClient, storage: new MemoryStorage(),
        now: () => new Date('2030-10-03T00:02:00.000Z'),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
      });
      pending.push(issue);void issue.catch(()=>{});
      await waitForPayerWait(db.prisma,blockingPid);
      unlock.release();
      await settlement;
      await expect(issue).rejects.toThrow('BILLING_INVOICE_WALLET_CHANGED_BEFORE_ISSUE');
      expect((await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
        id: draft.id,
      } })).status).toBe('DRAFT');
    } finally {
      unlock.release();
      await Promise.allSettled(pending);
      await Promise.all([settlementClient.$disconnect(), issueClient.$disconnect()]);
    }
  });

  it('reserves an issued cohort when invoice claim wins the payer lock', async () => {
    const october = '2030-10';
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    await createTestCapturedPaidLiability(db.prisma,{ data: {
      dispatchId, receiptId, serviceId: ids.service, providerServiceId: 'provider-test',
      orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: october,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    const original = await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
      id: ids.invoice,
    } });
    const invoice = await db.prisma.billingInvoice.create({ data: {
      orgId: ids.org, contractId: ids.contract,
      contractVersionId: original.contractVersionId,
      issuerProfileId: original.issuerProfileId, buyerProfileId: original.buyerProfileId,
      billingMonth: october, revision: 1, currency: 'USD',
      subtotalMinor: 130n, taxAmountMinor: 0n, totalMinor: 130n,
      taxTreatment: 'NO_TAX_CHARGED', taxRateBps: 0,
      taxLegalBasis: 'Fixture tax treatment',
      issuerSnapshot: original.issuerSnapshot as Prisma.InputJsonValue,
      buyerSnapshot: original.buyerSnapshot as Prisma.InputJsonValue,
      calculationDigest: 'd'.repeat(64),
      lines: { create: { serviceId: ids.service,
        serviceIdentifier: credential.service.identifier,
        serviceName: credential.service.name,
        amountMinor: 130n, currency: 'USD', position: 1 } },
      meteringRefs: { create: { serviceId: ids.service,
        ledgerSnapshotCursor: 'october-cohort',
        ledgerSnapshotSha256: 'd'.repeat(64),
        capturedAt: new Date('2030-11-01T00:00:00.000Z') } },
    }, include: { lines: true } });
    const line = invoice.lines[0];
    if (!line) throw new Error('OCTOBER_LINE_MISSING');
    await db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId: line.id, invoiceId: invoice.id, serviceId: ids.service,
      billingMonth: october, subscriptionMinor: 0n, usageMinor: 130n,
      taxMinor: 0n, invoiceCreditMinor: 0n, totalMinor: 130n,
      dueMinor: 130n, currency: 'USD', calculationDigest: invoice.calculationDigest,
    } });
    await db.prisma.billingInvoicePaidReceipt.create({ data: {
      invoiceId: invoice.id, serviceId: ids.service, orgId: ids.org,
      teamId: ids.team, billingMonth: october, dispatchId, receiptId,
      ratedMicrocredits: 1_300_000_000n, proofSha256: 'd'.repeat(64),
    } });
    const fundingId = randomUUID();
    const entryId = randomUUID();
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config(
        'app.admin_auth_domain', ${getAdminAuthDomain()}, true)`);
      await tx.billingCreditAdminAdjustment.create({ data: {
        id: fundingId, accountId: ids.account, creditAccountId: ids.creditAccount,
        orgId: ids.org, teamId: null, signedAmountMicrocredits: 1_300_000_000n,
        reason: 'Concurrent invoice funding fixture', idempotencyKey: fundingId,
        createdByUserId: ids.user, createdByEmail: ids.userEmail,
        createdByAdminDomain: getAdminAuthDomain(), creditEntryId: entryId,
      } });
      await tx.billingCreditEntry.create({ data: {
        id: entryId, creditAccountId: ids.creditAccount, direction: 'CREDIT',
        kind: 'ADJUSTMENT', amountMicrocredits: 1_300_000_000n,
        balanceAfterMicrocredits: 1_300_000_000n, currency: 'USD',
        idempotencyKey: fundingId, sourceType: 'credit_admin_adjustment',
        sourceId: fundingId, occurredAt: new Date('2030-11-03T00:00:00.000Z'),
      } });
    });
    const issuerClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const settlementClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const locked = deferred();
    const unlock = deferred();
    const pending:Promise<unknown>[]=[];let blockingPid=0;
    try {
      const issue = issueBillingInvoice({ invoiceId: invoice.id,
        actor: { email: 'operator@example.test' } }, {
        prisma: afterPayerLock(issuerClient, async tx => {
          blockingPid=(await tx.$queryRaw<Array<{pid:number}>>(Prisma.sql`SELECT pg_backend_pid() AS pid`))[0]?.pid??0;
          locked.release();
          await unlock.promise;
        }), storage: new MemoryStorage(),
        now: () => new Date('2030-11-03T00:01:00.000Z'),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
      });
      pending.push(issue);void issue.catch(()=>{});
      await Promise.race([locked.promise,issue.then(()=>{throw Error('Issue completed before lock');})]);
      const octoberPortfolio = { ...portfolio('mup_manual_issue_wins_1234567890123',
        '1', '2030-11-03T00:02:00.000Z'), scope: {
        organizationId: ids.org, teamId: ids.team, month: october,
        startsAt: '2030-10-01T00:00:00.000Z', endsAt: '2030-11-01T00:00:00.000Z',
      } };
      const settlement = settleCreditPortfolio({ creditAccountId: ids.creditAccount,
        credential, portfolio: octoberPortfolio }, { prisma: settlementClient });
      pending.push(settlement);void settlement.catch(()=>{});
      await waitForPayerWait(db.prisma,blockingPid);
      unlock.release();
      await Promise.allSettled(pending);
      await Promise.all([issue, settlement]);
      const consumed = await db.prisma.billingCreditUsageSettlement.findFirstOrThrow({ where: {
        creditAccountId: ids.creditAccount, serviceId: ids.service,
        billingMonth: october,
      } });
      expect(consumed.cumulativeCreditsConsumedMicrocredits).toBe(0n);
      expect((await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: {
        id: ids.creditAccount,
      } })).balanceMicrocredits).toBe(1_300_000_000n);
    } finally {
      unlock.release();
      await Promise.allSettled(pending);
      await Promise.all([issuerClient.$disconnect(), settlementClient.$disconnect()]);
    }
  });
}
