import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose, Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getAdminAuthDomain } from '../../src/config/env.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { manualInvoiceReservedMicroMinor } from
  '../../src/services/billing-credit-manual-invoice-cap.service.js';
import { calculateBillingContractInvoice } from
  '../../src/services/billing-invoice-calculation.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import type { BillingInvoicePdfStorage } from
  '../../src/services/billing-invoice-storage.service.js';
import type { NormalizedMeteringPortfolio, NormalizedMeteringUsage } from
  '../../src/services/billing-metering.types.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
const month = '2026-08';
const startsAt = '2026-08-01T00:00:00.000Z';
const endsAt = '2026-09-01T00:00:00.000Z';

class MemoryStorage implements BillingInvoicePdfStorage {
  private readonly bytes = new Map<string, Buffer>();
  async putImmutable(key: string, value: Uint8Array): Promise<void> {
    if (this.bytes.has(key)) throw new Error('DUPLICATE_TEST_DOCUMENT');
    this.bytes.set(key, Buffer.from(value));
  }
  async read(key: string): Promise<Buffer> {
    const value = this.bytes.get(key);
    if (!value) throw new Error('TEST_DOCUMENT_MISSING');
    return value;
  }
}

describe.skipIf(!enabled)('manual invoice paid receipt wallet cap', () => {
  let db: TestDb;
  let credential: Parameters<typeof settleCreditPortfolio>[0]['credential'];
  const ids = { user: '', userEmail: '', org: '', team: '', service: '', tariff: '', account: '',
    creditAccount: '', contract: '', invoice: '' };
  const receipts: Array<{ dispatchId: string; receiptId: string; cost: string }> = [];

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const user = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: randomUUID(),
    } });
    ids.user = user.id;
    ids.userEmail = user.email;
    await db.prisma.domainRole.create({ data: { userId: user.id,
      domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: user.id, name: 'Manual paid cohort',
      domain: `${randomUUID()}.example.test`, slug: `manual-${randomUUID().slice(0, 10)}`,
    } });
    ids.org = org.id;
    const team = await db.prisma.team.create({ data: { orgId: org.id,
      name: 'Source team', slug: `source-${randomUUID().slice(0, 10)}` } });
    ids.team = team.id;
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id,
      role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id,
      teamRole: 'owner' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: `manual-cap-${randomUUID()}`, name: 'Manual cap service',
      tariffHistoryFromMonth: '2026-01',
    } });
    ids.service = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'manual-cap', version: 1, name: 'Manual cap',
      mode: 'CUSTOM', collectionMode: 'MANUAL', markupBps: 3000,
      monthlyAmountMinor: 0n, monthlyChargeBasis: 'FLAT',
      usagePaymentMode: 'PAY_AS_YOU_GO', currency: 'USD',
    } });
    ids.tariff = tariff.id;
    await db.prisma.billingTariffTermEvent.create({ data: {
      serviceId: service.id, tariffId: tariff.id, source: 'SERVICE_DEFAULT',
      scopeKey: service.id, effectiveFromMonth: '2026-01', reason: 'test_seed',
    } });
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId: service.id, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      name: 'Manual cap key', keyPrefix: `cap_${randomUUID().slice(0, 8)}`,
      secretDigest: randomUUID(), actorIssuer: 'https://test.example',
      actorAudience: 'https://uoa.example', actorKeyId: randomUUID(),
      actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
      checkoutReturnOrigins: ['https://test.example'],
    } });
    credential = { ...appKey, service } as typeof credential;
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false,
    } });
    ids.account = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: account.id, orgId: org.id, teamId: team.id,
      scope: 'TEAM', scopeKey: `${org.id}:${team.id}`,
    } });
    const wallet = await db.prisma.billingCreditAccount.create({ data: {
      accountId: account.id, customerId: customer.id, orgId: org.id,
      teamId: team.id, scope: 'TEAM', scopeKey: `${org.id}:${team.id}`,
      currency: 'USD',
    } });
    ids.creditAccount = wallet.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId: org.id, reference: `manual-${randomUUID()}`, name: 'Manual cap agreement',
      status: 'ACTIVE', activatedAt: new Date(startsAt),
    } });
    ids.contract = contract.id;
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000,
      currency: 'USD', paymentTermsDays: 30, effectiveFromMonth: month,
    } });
    await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId: service.id,
      tariffId: tariff.id, monthlyAmountMinor: 0n,
    } });
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: `manual-cap-${randomUUID()}`, legalName: 'UOA Ltd',
      billingEmail: 'billing@example.test', address: { country: 'GB' },
      invoiceNumberPrefix: `M${randomUUID().slice(0, 6).toUpperCase()}`,
    } });
    await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId: org.id, legalName: 'Customer Ltd', billingEmail: 'ap@example.test',
      billingAddress: { country: 'GB' },
    } });
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId, receiptId, serviceId: service.id, providerServiceId: 'provider-test',
      orgId: org.id, teamId: team.id, userId: user.id, billingMonth: month,
      currency: 'USD', tariffId: tariff.id, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    receipts.push({ dispatchId, receiptId, cost: '1.000000000000000000' });
    const invoice = await calculateBillingContractInvoice({
      contractId: contract.id, issuerProfileId: issuer.id, billingMonth: month,
      taxTerms: { treatment: 'NO_TAX_CHARGED', rateBps: 0,
        legalBasis: 'Fixture tax treatment' }, actor: { email: 'operator@example.test' },
    }, { prisma: db.prisma, fetchMetering: async () => usage(service.identifier),
      collectFunding: vi.fn().mockResolvedValue({ credits: [], addons: [] }),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [team.id], snapshot: {
        id: 'team-proof', cursor: 'team-proof', capturedAt: endsAt,
        sha256: 'a'.repeat(64) } }),
      fetchPaidReceiptSet: async () => proof(service.identifier),
      now: () => new Date('2026-09-03T00:00:00.000Z'),
    });
    ids.invoice = invoice.id;
    expect(await db.prisma.billingInvoicePaidReceipt.count({ where: {
      invoiceId: invoice.id,
    } })).toBe(1);
    await issueBillingInvoice({ invoiceId: invoice.id,
      actor: { email: 'operator@example.test' } }, {
      prisma: db.prisma, storage: new MemoryStorage(),
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterAll(async () => { await db?.cleanup(); });

  function proof(product: string) {
    const digest = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
    for (const row of receipts) digest.update(JSON.stringify([
      row.dispatchId, row.receiptId, row.cost,
    ])).update('\n');
    return { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: product, organization_id: ids.org,
        team_id: ids.team, billing_month: month },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
        captured_at: endsAt, immutable: true as const },
      paid_receipt_count: String(receipts.length),
      paid_receipt_sha256: digest.digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256: 'a'.repeat(64),
      unresolved_paid_attempts: '0', signature: 'synthetic-signature',
    };
  }

  function line(cost: string) {
    return { serviceId: 'provider-test', usageUnit: 'tokens', calls: '1',
      inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
      estimatedProviderCost: null, actualProviderCost: cost,
      selectedProviderCost: cost, currency: 'USD', costProvenance: 'actual' as const,
      billingDisposition: 'paid' as const, billingProduct: credential.service.identifier,
      callerProduct: credential.service.identifier,
      originProduct: credential.service.identifier, userId: ids.user };
  }

  function usage(product: string): NormalizedMeteringUsage {
    return { schemaVersion: 1, product, groupBy: 'service',
      scope: { organizationId: ids.org, teamId: null, userId: null,
        month, startsAt, endsAt }, calls: '1', lines: [line('1')],
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: 'manual-coverage', cursor: 'manual-coverage',
        capturedAt: endsAt, immutable: true, sha256: 'a'.repeat(64) } };
  }

  function portfolio(cursor: string, cost: string, capturedAt: string):
  NormalizedMeteringPortfolio {
    return { schemaVersion: 1, contract: 'metering-portfolio-v1',
      perspectiveProduct: credential.service.identifier, groupBy: 'user',
      scope: { organizationId: ids.org, teamId: ids.team,
        month, startsAt, endsAt }, calls: '1', lines: [line(cost)],
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: cursor, cursor, capturedAt, immutable: true,
        sha256: 'a'.repeat(64) } };
  }

  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  function afterPayerLock(client: PrismaClient, action: () => Promise<void>): PrismaClient {
    return new Proxy(client, { get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        target.$transaction(async (tx) => callback(new Proxy(tx, {
          get(transaction, method, transactionReceiver) {
            if (method !== '$queryRaw') return Reflect.get(transaction, method, transactionReceiver);
            return async (...args: unknown[]) => {
              const result = await (transaction.$queryRaw as (...values: unknown[]) =>
                Promise<unknown>)(...args);
              const sql = String((args[0] as { strings?: readonly string[] })?.strings?.join('') ?? '');
              if (sql.includes('billing_credit_accounts') && sql.includes('FOR UPDATE')) {
                await action();
              }
              return result;
            };
          },
        })), options as never);
    } });
  }

  async function waitForPayerWait() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await db.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%billing_credit_accounts%FOR UPDATE%'`);
      if ((waiting[0]?.count ?? 0n) > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('invoice did not wait on the credit payer row');
  }

  it('keeps a late top-up off invoiced receipts but funds new paid receipts', async () => {
    const fundingId = randomUUID();
    const entryId = randomUUID();
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config(
        'app.admin_auth_domain', ${getAdminAuthDomain()}, true)`);
      await tx.billingCreditAdminAdjustment.create({ data: {
        id: fundingId, accountId: ids.account, creditAccountId: ids.creditAccount,
        orgId: ids.org, teamId: ids.team, signedAmountMicrocredits: 2_600_000_000n,
        reason: 'Late top-up fixture', idempotencyKey: fundingId,
        createdByUserId: ids.user, createdByEmail: ids.userEmail,
        createdByAdminDomain: getAdminAuthDomain(), creditEntryId: entryId,
      } });
      await tx.billingCreditEntry.create({ data: {
        id: entryId, creditAccountId: ids.creditAccount, direction: 'CREDIT',
        kind: 'ADJUSTMENT', amountMicrocredits: 2_600_000_000n,
        balanceAfterMicrocredits: 2_600_000_000n, currency: 'USD',
        idempotencyKey: fundingId, sourceType: 'credit_admin_adjustment',
        sourceId: fundingId, occurredAt: new Date('2026-09-04T00:00:01.000Z'),
      } });
    });
    await settleCreditPortfolio({ creditAccountId: ids.creditAccount,
      credential, portfolio: portfolio('mup_manual_old_12345678901234567',
        '1', '2026-09-04T00:01:00.000Z') }, { prisma: db.prisma });
    const first = await db.prisma.billingCreditUsageSettlement.findFirstOrThrow({ where: {
      creditAccountId: ids.creditAccount, billingMonth: month, serviceId: ids.service,
    } });
    expect(first.cumulativeCreditsConsumedMicrocredits).toBe(0n);
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId: `dispatch-${randomUUID()}`, receiptId: `receipt-${randomUUID()}`,
      serviceId: ids.service, providerServiceId: 'provider-test', orgId: ids.org,
      teamId: ids.team, userId: ids.user, billingMonth: month,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    await settleCreditPortfolio({ creditAccountId: ids.creditAccount,
      credential, portfolio: portfolio('mup_manual_new_12345678901234567',
        '2', '2026-09-04T00:02:00.000Z') }, { prisma: db.prisma });
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
      status: 'VOID', voidedAt: new Date('2026-09-05T00:00:00.000Z'),
      voidReason: 'Fixture moves collection authority to legacy invoice',
    } });
    const secondTeam = await db.prisma.team.create({ data: {
      orgId: ids.org, name: 'Other source team',
      slug: `other-${randomUUID().slice(0, 10)}`,
    } });
    await db.prisma.billingPaidUsageLiability.create({ data: {
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
      issueDate: new Date('2026-09-05T00:00:00.000Z'),
      dueDate: new Date('2026-10-05T00:00:00.000Z'),
    } });
    await expect(db.prisma.$transaction((tx) => manualInvoiceReservedMicroMinor(tx, {
      orgId: ids.org, teamId: ids.team, serviceId: ids.service,
      billingMonth: month, creditAccountId: ids.creditAccount,
    }))).rejects.toThrow('BILLING_CREDIT_MANUAL_INVOICE_COHORT_UNPROVEN');
  });

  it('rejects a stale draft when concurrent wallet settlement wins the payer lock', async () => {
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    const september = '2026-09';
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId, receiptId, serviceId: ids.service, providerServiceId: 'provider-test',
      orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: september,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '1', ratedQuanta: '0',
      ratedMicrocredits: 1_300_000_000n,
    } });
    const starts = '2026-09-01T00:00:00.000Z';
    const ends = '2026-10-01T00:00:00.000Z';
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
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    });
    const settlementClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const issueClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const locked = deferred();
    const unlock = deferred();
    try {
      const SeptemberPortfolio = { ...portfolio('mup_manual_race_12345678901234567',
        '1', '2026-10-03T00:01:00.000Z'),
      scope: { organizationId: ids.org, teamId: ids.team, month: september,
        startsAt: starts, endsAt: ends } };
      const settlement = settleCreditPortfolio({ creditAccountId: ids.creditAccount,
        credential, portfolio: SeptemberPortfolio }, {
        prisma: afterPayerLock(settlementClient, async () => {
          locked.release();
          await unlock.promise;
        }),
      });
      await locked.promise;
      const issue = issueBillingInvoice({ invoiceId: draft.id,
        actor: { email: 'operator@example.test' } }, {
        prisma: issueClient, storage: new MemoryStorage(),
        now: () => new Date('2026-10-03T00:02:00.000Z'),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
      });
      await waitForPayerWait();
      unlock.release();
      await settlement;
      await expect(issue).rejects.toThrow('BILLING_INVOICE_WALLET_CHANGED_BEFORE_ISSUE');
      expect((await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
        id: draft.id,
      } })).status).toBe('DRAFT');
    } finally {
      unlock.release();
      await Promise.all([settlementClient.$disconnect(), issueClient.$disconnect()]);
    }
  });
});
