import { createHash, randomUUID } from 'node:crypto';

import {
  BillingAppKeyPurpose, BillingAssignmentScope, BillingCreditEntryDirection,
  BillingCreditEntryKind, BillingCreditInvoiceTaxTreatment, BillingCreditPaymentInvoiceSource,
  BillingCreditPaymentInvoiceState, BillingCreditPaymentInvoiceTaxSource,
  BillingCollectionMode, BillingInvoiceStatus, BillingTariffMode,
  BillingOrganisationContractStatus, MembershipStatus,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  downloadCustomerInvoice, getCustomerInvoiceDetail, listCustomerInvoices,
} from '../../src/services/billing-customer-invoice-read.service.js';
import type { BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { createTestDb } from '../helpers/test-db.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!enabled)('actual customer invoice persistence and scope', () => {
  let db: TestDb;
  let orgId: string;
  let teamId: string;
  let otherTeamId: string;
  let ownerId: string;
  let managerId: string;
  let serviceId: string;
  let serviceIdentifier: string;
  let paymentIds: string[];
  let mixedInvoiceId: string;
  let legalBytes: Buffer;

  function context(userId: string, selectedTeamId = teamId): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: serviceIdentifier,
      name: 'Invoice Proof' } } as BillingCycleContext['credential'],
    actorToken: 'verified-test-actor', endpoint: '/billing/v1/invoices/list',
    request: { product: serviceIdentifier, organisationId: orgId,
      teamId: selectedTeamId, userId } };
  }

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: `${randomUUID()}@example.com`,
      name: 'Owner',
    } });
    const manager = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: `${randomUUID()}@example.com`,
      name: 'Team Manager',
    } });
    ownerId = owner.id;
    managerId = manager.id;
    const org = await db.prisma.organisation.create({ data: {
      domain: `${randomUUID()}.example.com`, name: 'Invoice Proof',
      slug: `invoice-${randomUUID().slice(0, 10)}`, ownerId,
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: {
      orgId, name: 'Selected', slug: `selected-${randomUUID().slice(0, 10)}`,
    } });
    const other = await db.prisma.team.create({ data: {
      orgId, name: 'Other', slug: `other-${randomUUID().slice(0, 10)}`,
    } });
    teamId = team.id;
    otherTeamId = other.id;
    await db.prisma.orgMember.createMany({ data: [
      { orgId, userId: ownerId, role: 'owner' },
      { orgId, userId: managerId, role: 'member' },
    ] });
    await db.prisma.teamMember.createMany({ data: [
      { teamId, userId: ownerId, teamRole: 'owner' },
      { teamId: otherTeamId, userId: ownerId, teamRole: 'owner' },
      { teamId, userId: managerId, teamRole: 'admin' },
    ] });
    serviceIdentifier = `invoice-${randomUUID()}`;
    const service = await db.prisma.billingService.create({ data: {
      identifier: serviceIdentifier, name: 'Invoice Proof',
    } });
    serviceId = service.id;
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      name: 'Invoice Proof', keyPrefix: 'invoice_proof',
      secretDigest: randomUUID(), actorIssuer: 'https://test.example',
      actorAudience: 'https://uoa.example', actorKeyId: randomUUID(),
      actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
      checkoutReturnOrigins: ['https://test.example'],
    } });
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false,
    } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: account.id, orgId, teamId, scope: BillingAssignmentScope.TEAM,
      scopeKey: `${orgId}:${teamId}`, stripeCustomerId: `cus_${randomUUID()}`,
    } });
    const wallet = await db.prisma.billingCreditAccount.create({ data: {
      accountId: account.id, customerId: customer.id, orgId, teamId,
      scope: BillingAssignmentScope.TEAM, scopeKey: `${orgId}:${teamId}`,
      currency: 'USD',
    } });
    const policy = await db.prisma.billingCreditFundingPolicy.create({ data: {
      serviceId, currency: 'USD', version: 1, topUpEnabled: true,
      automaticConsentVersion: 'test-v1',
    } });
    const offer = await db.prisma.billingCreditTopUpOffer.create({ data: {
      policyId: policy.id, serviceId, key: 'five', version: 1,
      catalogKey: 'invoice-proof', catalogVersion: 1,
      name: 'Five dollars', description: 'Prepaid credit purchase',
      paymentAmountMinor: 500n, creditsReceivedMicrocredits: 5_000_000_000n,
    } });
    const catalog = await db.prisma.billingCreditTopUpCatalog.create({ data: {
      accountId: account.id, key: 'invoice-proof', version: 1, currency: 'USD',
      paymentAmountMinor: 500n, creditsReceivedMicrocredits: 5_000_000_000n,
      stripeLookupKey: `invoice-${randomUUID()}`,
      stripeProductId: `prod_${randomUUID()}`,
      stripePriceId: `price_${randomUUID()}`,
    } });
    paymentIds = [];
    for (const [index, paidAt] of [
      new Date('2026-09-30T23:59:59.000Z'),
      new Date('2026-09-30T23:59:59.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
    ].entries()) {
      const payment = await db.prisma.$transaction(async (tx) => {
        const checkout = await tx.billingCreditTopUpCheckout.create({ data: {
        accountId: account.id, creditAccountId: wallet.id, customerId: customer.id,
        catalogId: catalog.id, serviceId, appKeyId: appKey.id, offerId: offer.id,
        actorJti: randomUUID(), requestedByUserId: ownerId,
        paymentAmountMinor: 500n, creditsReceivedMicrocredits: 5_000_000_000n,
        currency: 'USD', successUrlDigest: 'a'.repeat(64),
        cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: paidAt,
      } });
        const paymentIntentId = `pi_${randomUUID()}`;
        const checkoutSessionId = `cs_${randomUUID()}`;
        const chargeId = `ch_${randomUUID()}`;
        const event = await tx.billingStripeWebhookEvent.create({ data: {
          accountId: account.id, stripeEventId: `evt_${randomUUID()}`,
          type: 'payment_intent.succeeded', livemode: false, stripeCreatedAt: paidAt,
          stripeObjectId: paymentIntentId, stripeObjectStatus: 'succeeded',
          stripeCustomerId: customer.stripeCustomerId,
          stripeCheckoutSessionId: checkoutSessionId,
          stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId,
          amountMinor: 500n, currency: 'USD',
        } });
        const entry = await tx.billingCreditEntry.create({ data: {
        creditAccountId: wallet.id, serviceId, appKeyId: appKey.id,
        attributedUserId: ownerId, direction: BillingCreditEntryDirection.CREDIT,
        kind: BillingCreditEntryKind.TOP_UP, amountMicrocredits: 5_000_000_000n,
        balanceAfterMicrocredits: BigInt(index + 1) * 5_000_000_000n,
        currency: 'USD', idempotencyKey: randomUUID(),
        sourceType: 'credit_top_up_checkout', sourceId: checkout.id, occurredAt: paidAt,
      } });
        await tx.billingCreditTopUpCheckout.update({ where: { id: checkout.id }, data: {
          status: 'COMPLETE', stripeCheckoutSessionId: checkoutSessionId,
          stripePaymentIntentId: paymentIntentId,
          completionWebhookEventId: event.id, completedAt: paidAt,
          creditEntryId: entry.id,
        } });
        return tx.billingCreditPaymentInvoice.create({ data: {
        accountId: account.id, livemode: false,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
        source: BillingCreditPaymentInvoiceSource.MANUAL_TOP_UP,
        topUpCheckoutId: checkout.id, creditEntryId: entry.id,
        creditAccountId: wallet.id, serviceId, appKeyId: appKey.id,
        orgId, teamId, attributedUserId: ownerId,
        stripeCustomerId: customer.stripeCustomerId ?? '',
        currency: 'USD', grossAmountMinor: 500n,
        creditsPurchasedMicrocredits: 5_000_000_000n, paidAt,
        } });
      });
      paymentIds.push(payment.id);
    }
    legalBytes = Buffer.from('%PDF-1.7\nreal legal source fixture');
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: `issuer-${randomUUID()}`, legalName: 'UOA Ltd',
      billingEmail: 'billing@example.com', address: { line1: '1 Example Road' },
      invoiceNumberPrefix: `INV${randomUUID().slice(0, 8).toUpperCase()}`,
    } });
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId, legalName: 'Buyer Ltd', billingEmail: 'buyer@example.com',
      billingAddress: { line1: '2 Example Road' },
    } });
    const otherService = await db.prisma.billingService.create({ data: {
      identifier: `other-${randomUUID()}`, name: 'Other Product',
    } });
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId, reference: `invoice-${randomUUID()}`, name: 'Mixed source',
      createdByEmail: 'admin@example.com',
    } });
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000,
      currency: 'USD', paymentTermsDays: 30, effectiveFromMonth: '2026-09',
      createdByEmail: 'admin@example.com',
    } });
    for (const current of [service, otherService]) {
      const tariff = await db.prisma.billingTariff.create({ data: {
        serviceId: current.id, key: 'manual', version: 1, name: 'Manual',
        mode: BillingTariffMode.CUSTOM, collectionMode: BillingCollectionMode.MANUAL,
        markupBps: 3000, currency: 'USD',
        monthlyAmountMinor: current.id === serviceId ? 1000n : 500n,
      } });
      const assignment = await db.prisma.billingTariffAssignment.create({ data: {
        serviceId: current.id, tariffId: tariff.id, orgId,
        scope: BillingAssignmentScope.ORGANISATION, scopeKey: orgId,
        createdByEmail: 'admin@example.com',
      } });
      await db.prisma.billingContractServiceTerm.create({ data: {
        contractVersionId: version.id, serviceId: current.id, tariffId: tariff.id,
        tariffAssignmentId: assignment.id,
        monthlyAmountMinor: current.id === serviceId ? 1000n : 500n,
      } });
    }
    await db.prisma.billingOrganisationContract.update({ where: { id: contract.id },
      data: { status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-09-01T00:00:00.000Z') } });
    const mixed = await db.prisma.$transaction(async (tx) => {
      const created = await tx.billingInvoice.create({ data: {
      orgId, contractId: contract.id, contractVersionId: version.id,
      issuerProfileId: issuer.id, buyerProfileId: buyer.id,
      billingMonth: '2026-09', currency: 'USD',
      subtotalMinor: 1500n, totalMinor: 1500n,
      issuerSnapshot: { legal_name: 'UOA Ltd' }, buyerSnapshot: { legal_name: 'Buyer Ltd' },
      calculationDigest: 'c'.repeat(64),
      } });
      await tx.billingInvoiceLine.createMany({ data: [
        { serviceId, serviceIdentifier, serviceName: 'Invoice Proof',
          invoiceId: created.id, amountMinor: 1000n, currency: 'USD', position: 1 },
        { serviceId: otherService.id, serviceIdentifier: otherService.identifier,
          invoiceId: created.id, serviceName: 'Other Product', amountMinor: 500n,
          currency: 'USD', position: 2 },
      ] });
      await tx.billingInvoiceMeteringReference.createMany({ data: [service, otherService]
        .map((current) => ({ invoiceId: created.id, serviceId: current.id,
          ledgerSnapshotCursor: `proof-${current.id}`,
          ledgerSnapshotSha256: 'e'.repeat(64),
          capturedAt: new Date('2026-10-01T00:00:00.000Z'),
        })) });
      return created;
    });
    await db.prisma.billingInvoice.update({ where: { id: mixed.id }, data: {
      status: BillingInvoiceStatus.ISSUING, invoiceNumber: `MIX-${randomUUID()}`,
      issueDate: new Date('2026-09-30T00:00:00.000Z'),
      dueDate: new Date('2026-10-30T00:00:00.000Z'),
    } });
    await db.prisma.billingInvoice.update({ where: { id: mixed.id }, data: {
      status: BillingInvoiceStatus.ISSUED,
      issuedAt: new Date('2026-09-30T00:00:00.000Z'),
      pdfObjectKey: `billing-invoices/${randomUUID()}.pdf`,
      pdfSha256: 'd'.repeat(64), pdfTemplateVersion: 'proof-v1',
    } });
    mixedInvoiceId = mixed.id;
    const taxPolicy = await db.prisma.billingCreditInvoiceTaxPolicy.create({ data: {
      accountId: account.id, version: 1, issuerProfileId: issuer.id,
      jurisdictionCountry: 'GB', treatment: BillingCreditInvoiceTaxTreatment.NO_TAX_CHARGED,
      rateBps: 0, legalBasisReference: 'Explicit local invoice-reader fixture policy',
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      createdByUserId: ownerId, createdByEmail: owner.email,
    } });
    await db.prisma.billingCreditPaymentInvoice.update({ where: { id: paymentIds[0] }, data: {
      state: BillingCreditPaymentInvoiceState.ISSUED,
      taxAmountMinor: 0n, taxSource: BillingCreditPaymentInvoiceTaxSource.ISSUER_POLICY,
      taxEvidenceReference: taxPolicy.id, taxPolicyId: taxPolicy.id,
      issuerProfileId: issuer.id, buyerProfileId: buyer.id,
      issuerSnapshot: { legal_name: 'UOA Ltd' }, buyerSnapshot: { legal_name: 'Buyer Ltd' },
      invoiceNumber: `INV-${randomUUID()}`, issuedAt: new Date('2026-10-01T01:00:00.000Z'),
      pdfObjectKey: `billing-invoices/${randomUUID()}.pdf`,
      pdfSha256: createHash('sha256').update(legalBytes).digest('hex'),
    } });
  });

  afterAll(async () => { await db?.cleanup(); });

  it('lists every charge in its paid month, including a later-issued PDF and pending document', async () => {
    const viewer = context(ownerId);
    const first = await listCustomerInvoices(viewer, { chargeMonth: '2026-09', limit: 1 },
      { prisma: db.prisma });
    expect(first.invoices).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = await listCustomerInvoices(viewer, {
      chargeMonth: '2026-09', limit: 1, cursor: first.next_cursor ?? undefined,
    }, { prisma: db.prisma });
    expect(second.invoices).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.invoices, ...second.invoices].map((row) => row.invoice_id)))
      .toEqual(new Set(paymentIds.slice(0, 2).map((id) => `prepaid:${id}`)));
    expect([...first.invoices, ...second.invoices].map((row) => row.status).sort())
      .toEqual(['paid', 'pending_document']);
    const november = await listCustomerInvoices(viewer, { chargeMonth: '2026-10' },
      { prisma: db.prisma });
    expect(november.invoices.map((row) => row.invoice_id)).toEqual([`prepaid:${paymentIds[2]}`]);
  });

  it('denies a different selected team and rechecks revocation after a blocked PDF read', async () => {
    const invoiceId = `prepaid:${paymentIds[0]}`;
    await expect(getCustomerInvoiceDetail(context(ownerId, otherTeamId), invoiceId,
      { prisma: db.prisma })).rejects.toMatchObject({ statusCode: 404 });
    const manager = context(managerId);
    expect((await getCustomerInvoiceDetail(manager, invoiceId,
      { prisma: db.prisma })).document?.document_id).toBe(invoiceId);
    const accessible = await downloadCustomerInvoice(manager, invoiceId, invoiceId,
      { prisma: db.prisma, storage: {
        putImmutable: async () => {}, read: async () => legalBytes,
      } });
    expect(accessible.bytes).toEqual(legalBytes);
    expect(accessible.contentType).toBe('application/pdf');
    let unblock: ((value: Buffer) => void) | undefined;
    let begun: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => { begun = resolve; });
    const storage: BillingInvoicePdfStorage = {
      putImmutable: async () => {},
      read: async () => { begun?.(); return new Promise<Buffer>((resolve) => { unblock = resolve; }); },
    };
    const pending = downloadCustomerInvoice(manager, invoiceId, invoiceId,
      { prisma: db.prisma, storage });
    await reading;
    await db.prisma.teamMember.update({ where: { teamId_userId: {
      teamId, userId: managerId,
    } }, data: { status: MembershipStatus.REMOVED } });
    unblock?.(legalBytes);
    await expect(pending).rejects.toMatchObject({ statusCode: 403 });
  });

  it('never discloses a mixed-product legal invoice through one product key', async () => {
    const viewer = context(ownerId);
    const list = await listCustomerInvoices(viewer, { chargeMonth: '2026-09' },
      { prisma: db.prisma });
    expect(list.invoices.some((invoice) => invoice.invoice_id ===
      `manual:${mixedInvoiceId}`)).toBe(false);
    await expect(getCustomerInvoiceDetail(viewer, `manual:${mixedInvoiceId}`,
      { prisma: db.prisma })).rejects.toMatchObject({ statusCode: 404 });
    await expect(downloadCustomerInvoice(viewer, `manual:${mixedInvoiceId}`,
      `manual:${mixedInvoiceId}`, { prisma: db.prisma, storage: {
        putImmutable: async () => {}, read: async () => legalBytes,
      } })).rejects.toMatchObject({ statusCode: 404 });
  });
});
