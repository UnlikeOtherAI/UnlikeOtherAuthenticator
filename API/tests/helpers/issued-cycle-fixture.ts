import { BillingAssignmentScope, BillingCollectionMode, BillingInvoiceStatus, BillingMonthlyChargeBasis, BillingOrganisationContractStatus, BillingTariffMode, } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, vi } from 'vitest';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { type BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { createTestDb } from '../helpers/test-db.js';

export const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

export type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

export class MemoryStorage implements BillingInvoicePdfStorage {
  readonly objects = new Map<string, Buffer>();

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(key)) throw new Error('DUPLICATE_TEST_STORAGE_KEY');
    this.objects.set(key, Buffer.from(bytes));
  }

  async read(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error('TEST_STORAGE_KEY_MISSING');
    return value;
  }
}

export let db: TestDb;

export let storage: MemoryStorage;

export let serviceId: string;

export let serviceIdentifier: string;

export let orgId: string;

export let teamId: string;

export let ownerId: string;

export let tariffId: string;

export let termId: string;

export let invoiceId: string;

export let pendingCycleId: string;

export let finalizedCycleId: string;

export function context(): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: serviceIdentifier,
      name: 'Cycle Issuer Service' } } as BillingCycleContext['credential'],
    actorToken: 'test-signed-actor', endpoint: '/billing/v1/cycles/detail',
    request: { product: serviceIdentifier, organisationId: orgId, teamId, userId: ownerId } };
  }

export function setupIssuedCycleFixture() {
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    storage = new MemoryStorage();
    const owner = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`,
      userKey: `${randomUUID()}@example.com`, name: 'Owner' } });
    ownerId = owner.id;
    const org = await db.prisma.organisation.create({ data: {
      domain: `${randomUUID()}.example.com`, name: 'Cycle Issuer Test',
      slug: `cycle-${randomUUID().slice(0, 10)}`, ownerId,
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId, name: 'Selected Team',
      slug: `team-${randomUUID().slice(0, 10)}` } });
    teamId = team.id;
    await db.prisma.orgMember.create({ data: { orgId, userId: ownerId, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId, userId: ownerId, teamRole: 'owner' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: process.env.BILLING_CONFORMANCE_PRODUCT ?? `cycle-issuer-${randomUUID()}`,
      name: 'Cycle Issuer Service',
      tariffHistoryFromMonth: '2026-01',
    } });
    serviceId = service.id;
    serviceIdentifier = service.identifier;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'standard', version: 1, name: 'Standard',
      mode: BillingTariffMode.CUSTOM, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 2000n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD', usageCurrency: 'USD',
    } });
    tariffId = tariff.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId, reference: `cycle-${randomUUID()}`, name: 'Monthly Agreement',
      createdByEmail: 'admin@example.com',
    } });
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000, currency: 'USD',
      paymentTermsDays: 30, effectiveFromMonth: '2026-03',
      createdByEmail: 'admin@example.com',
    } });
    const assignment = await db.prisma.billingTariffAssignment.create({ data: {
      serviceId, tariffId, orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, scopeKey: orgId,
      createdByEmail: 'admin@example.com',
    } });
    const term = await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId, tariffId,
      tariffAssignmentId: assignment.id, monthlyAmountMinor: 2000n,
    } });
    termId = term.id;
    await db.prisma.billingOrganisationContract.update({ where: { id: contract.id },
      data: { status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-03-01T00:00:00.000Z') } });
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: `issuer-${randomUUID().slice(0, 10)}`, legalName: 'UOA Ltd',
      billingEmail: 'billing@example.com', address: { country: 'GB', line1: 'One Street' },
      invoiceNumberPrefix: `U${randomUUID().slice(0, 6).toUpperCase()}`,
    } });
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId, legalName: 'Customer Ltd', billingEmail: 'ap@example.com',
      billingAddress: { country: 'GB', line1: 'Two Street' },
    } });
    const invoice = await db.prisma.billingInvoice.create({ data: {
      orgId, contractId: contract.id, contractVersionId: version.id,
      issuerProfileId: issuer.id, buyerProfileId: buyer.id,
      billingMonth: '2026-03', revision: 1, status: BillingInvoiceStatus.DRAFT,
      currency: 'USD',
      subtotalMinor: 2000n, totalMinor: 2000n,
      issuerSnapshot: { legal_name: issuer.legalName,
        billing_email: issuer.billingEmail, address: issuer.address },
      buyerSnapshot: { legal_name: buyer.legalName,
        billing_email: buyer.billingEmail, billing_address: buyer.billingAddress },
      calculationDigest: 'c'.repeat(64),
      lines: { create: { serviceId, serviceIdentifier, serviceName: service.name,
        amountMinor: 2000n, currency: 'USD', position: 1 } },
      meteringRefs: { create: { serviceId, ledgerSnapshotCursor: 'issuer-coverage',
        ledgerSnapshotSha256: 'd'.repeat(64),
        capturedAt: new Date('2026-04-01T00:00:00.000Z') } },
    } });
    invoiceId = invoice.id;
    const frozenLine = await db.prisma.billingInvoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    await db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId: frozenLine.id, invoiceId, serviceId, billingMonth: '2026-03',
      subscriptionMinor: 2000n, usageMinor: 0n, taxMinor: 0n,
      invoiceCreditMinor: 0n, totalMinor: 2000n, dueMinor: 2000n,
      currency: 'USD', calculationDigest: 'c'.repeat(64),
    } });
    await issueBillingInvoice({ invoiceId, actor: { email: 'admin@example.com' } }, {
      prisma: db.prisma, storage, now: () => new Date('2026-04-01T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
    });
    const source = { kind: 'manual' as const, id: termId };
    const quote = { source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2026-03', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null };
    const pending = await prepareBillingCycleClose({ source, billingMonth: '2026-03' }, {
      prisma: db.prisma, now: () => new Date('2026-04-02T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [], snapshot: {
        id: 'empty-team-coverage', cursor: 'empty-team-coverage',
        capturedAt: '2026-04-02T00:00:00.000Z', sha256: 'a'.repeat(64),
      } }),
    });
    pendingCycleId = pending.cycleId;
  });
  afterAll(async () => { await db?.cleanup(); });
}

export function rememberPendingCycle(id: string) { pendingCycleId = id; }
export function rememberFinalizedCycle(id: string) { finalizedCycleId = id; }
