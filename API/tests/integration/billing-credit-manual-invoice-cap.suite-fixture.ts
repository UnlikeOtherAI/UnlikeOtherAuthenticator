import { captureTestOrganisationFinancialBinding,createTestCapturedPaidLiability } from '../helpers/organisation-financial-binding.js';
import { createHash, randomUUID } from 'node:crypto';
import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';

import { calculateBillingContractInvoice } from '../../src/services/billing-invoice-calculation.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import type { NormalizedMeteringPortfolio, NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

import { createTestDb } from '../helpers/test-db.js';
export const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);

export type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

export const month = '2030-08';

export const startsAt = '2030-08-01T00:00:00.000Z';

export const endsAt = '2030-09-01T00:00:00.000Z';

export class MemoryStorage implements BillingInvoicePdfStorage {
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

export let db: TestDb;

export let credential: Parameters<typeof settleCreditPortfolio>[0]['credential'];

export const ids = { user: '', userEmail: '', org: '', team: '', service: '', tariff: '', account: '',
    creditAccount: '', contract: '', invoice: '' };

export const receipts: Array<{ dispatchId: string; receiptId: string; cost: string }> = [];

export function proof(product: string) {
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

export function line(cost: string) {
    return { serviceId: 'provider-test', usageUnit: 'tokens', calls: '1',
      inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
      estimatedProviderCost: null, actualProviderCost: cost,
      selectedProviderCost: cost, currency: 'USD', costProvenance: 'actual' as const,
      billingDisposition: 'paid' as const, billingProduct: credential.service.identifier,
      callerProduct: credential.service.identifier,
      originProduct: credential.service.identifier, userId: ids.user };
  }

export function usage(product: string): NormalizedMeteringUsage {
    return { schemaVersion: 1, product, groupBy: 'service',
      scope: { organizationId: ids.org, teamId: null, userId: null,
        month, startsAt, endsAt }, calls: '1', lines: [line('1')],
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: 'manual-coverage', cursor: 'manual-coverage',
        capturedAt: endsAt, immutable: true, sha256: 'a'.repeat(64) } };
  }

export function portfolio(cursor: string, cost: string, capturedAt: string):
  NormalizedMeteringPortfolio {
    return { schemaVersion: 1, contract: 'metering-portfolio-v1',
      perspectiveProduct: credential.service.identifier, groupBy: 'user',
      scope: { organizationId: ids.org, teamId: ids.team,
        month, startsAt, endsAt }, calls: '1', lines: [line(cost)],
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: cursor, cursor, capturedAt, immutable: true,
        sha256: 'a'.repeat(64) } };
  }
export function setupPersistenceSuite() {
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
      tariffHistoryFromMonth: '2030-01',
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
      scopeKey: service.id, effectiveFromMonth: '2030-01', reason: 'test_seed',
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
    const binding=await captureTestOrganisationFinancialBinding(db.prisma,org.id);
    const account=await db.prisma.billingStripeAccount.findUniqueOrThrow({where:{id:binding.billingAccountId}});
    ids.account = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: account.id, orgId: org.id, teamId: null,
      scope: 'ORGANISATION', scopeKey: org.id,
    } });
    const wallet = await db.prisma.billingCreditAccount.create({ data: {
        createdAt: new Date('2030-01-01T00:00:00Z'),
      accountId: account.id, customerId: customer.id, orgId: org.id,
      teamId: null, scope: 'ORGANISATION', scopeKey: org.id,
      currency: 'USD',
    } });
    ids.creditAccount = wallet.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: { ...binding,
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
    await createTestCapturedPaidLiability(db.prisma,{ data: {
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
      now: () => new Date('2030-09-03T00:00:00.000Z'),
    });
    ids.invoice = invoice.id;
    expect(await db.prisma.billingInvoicePaidReceipt.count({ where: {
      invoiceId: invoice.id,
    } })).toBe(1);
    await issueBillingInvoice({ invoiceId: invoice.id,
      actor: { email: 'operator@example.test' } }, {
      prisma: db.prisma, storage: new MemoryStorage(),
      now: () => new Date('2030-09-04T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
    });
  });
afterAll(async () => { await db?.cleanup(); vi.unstubAllEnvs(); });
}
