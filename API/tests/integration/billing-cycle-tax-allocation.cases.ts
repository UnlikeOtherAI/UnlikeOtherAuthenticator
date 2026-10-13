import { BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis, BillingTariffMode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { captureIssuedManualBillingCycle } from '../../src/services/billing-cycle-manual-invoice.service.js';
import { refreshIssuedManualBillingCyclePayment } from '../../src/services/billing-cycle-manual-payment.service.js';
import { getBillingCycleDetail } from '../../src/services/billing-cycle-read.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import { exportBillingConformanceFixture } from '../helpers/billing-conformance-export.js';
import { context, db, invoiceId, orgId, ownerId, serviceId, serviceIdentifier, storage, tariffId, teamId, termId } from '../helpers/issued-cycle-fixture.js';

export function registerMultiServiceTaxAllocationCase() {
  it('requires exact multi-service tax line allocations without guessed splits',
    async () => {
      const original = await db.prisma.billingInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      const secondService = await db.prisma.billingService.create({ data: {
        identifier: `other-${randomUUID()}`, name: 'Other product',
      } });
      const secondTariff = await db.prisma.billingTariff.create({ data: {
        serviceId: secondService.id, key: 'standard', version: 1,
        name: 'Other standard', mode: BillingTariffMode.CUSTOM,
        collectionMode: BillingCollectionMode.MANUAL,
        monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
        markupBps: 3000, monthlyAmountMinor: 0n, currency: 'USD', usageCurrency: 'USD',
      } });
      const secondAssignment = await db.prisma.billingTariffAssignment.create({ data: {
        serviceId: secondService.id, tariffId: secondTariff.id, orgId,
        teamId: null, scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: orgId,
      } });
      const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
        contractId: original.contractId, version: 2, usageMarkupBps: 3000,
        currency: 'USD', paymentTermsDays: 30, effectiveFromMonth: '2026-05',
      } });
      const originalTerm = await db.prisma.billingContractServiceTerm.findUniqueOrThrow({
        where: { id: termId },
      });
      await db.prisma.billingContractServiceTerm.createMany({ data: [
        { contractVersionId: version.id, serviceId, tariffId,
          tariffAssignmentId: originalTerm.tariffAssignmentId,
          monthlyAmountMinor: 2000n },
        { contractVersionId: version.id, serviceId: secondService.id,
          tariffId: secondTariff.id, tariffAssignmentId: secondAssignment.id,
          monthlyAmountMinor: 0n },
      ] });
      const firstTerm = await db.prisma.billingContractServiceTerm.findFirstOrThrow({
        where: { contractVersionId: version.id, serviceId },
      });
      const invoice = await db.prisma.billingInvoice.create({ data: {
        orgId, contractId: original.contractId, contractVersionId: version.id,
        issuerProfileId: original.issuerProfileId,
        buyerProfileId: original.buyerProfileId,
        billingMonth: '2026-05', revision: 1, currency: 'USD',
        subtotalMinor: 3000n, taxAmountMinor: 300n,
        creditsAppliedMinor: 0n, totalMinor: 3300n,
        calculationDigest: 'f'.repeat(64),
        issuerSnapshot: original.issuerSnapshot as object,
        buyerSnapshot: original.buyerSnapshot as object,
        lines: { create: [
          { serviceId, serviceIdentifier, serviceName: 'Cycle Issuer Service',
            amountMinor: 2000n, currency: 'USD', position: 1 },
          { serviceId: secondService.id, serviceIdentifier: secondService.identifier,
            serviceName: secondService.name, amountMinor: 1000n,
            currency: 'USD', position: 2 },
        ] },
        meteringRefs: { create: [{ serviceId, ledgerSnapshotCursor: 'mixed-first',
          ledgerSnapshotSha256: 'a'.repeat(64),
          capturedAt: new Date('2026-06-01T00:00:00.000Z') },
        { serviceId: secondService.id, ledgerSnapshotCursor: 'mixed-second',
          ledgerSnapshotSha256: 'b'.repeat(64),
          capturedAt: new Date('2026-06-01T00:00:00.000Z') }] },
      }, include: { lines: true } });
      const firstLine = invoice.lines.find((line) => line.serviceId === serviceId);
      const secondLine = invoice.lines.find((line) => line.serviceId === secondService.id);
      if (!firstLine || !secondLine) throw new Error('TEST_INVOICE_LINE_MISSING');
      await db.prisma.$transaction(async (tx) => {
        await tx.billingInvoiceLineFinancialAllocation.createMany({ data: [
          { lineId: firstLine.id, invoiceId: invoice.id, serviceId,
            billingMonth: '2026-05', subscriptionMinor: 2000n, usageMinor: 0n,
            taxMinor: 200n, invoiceCreditMinor: 0n, totalMinor: 2200n,
            dueMinor: 2200n, currency: 'USD', calculationDigest: 'f'.repeat(64) },
          { lineId: secondLine.id, invoiceId: invoice.id,
            serviceId: secondService.id, billingMonth: '2026-05',
            subscriptionMinor: 0n, usageMinor: 1000n, taxMinor: 100n,
            invoiceCreditMinor: 0n, totalMinor: 1100n, dueMinor: 1100n,
            currency: 'USD', calculationDigest: 'f'.repeat(64) },
        ] });
      });
      const lines = await db.prisma.billingInvoiceLineFinancialAllocation.findMany({
        where: { invoiceId: invoice.id }, orderBy: { lineId: 'asc' },
      });
      expect(lines.reduce((sum, line) => sum + line.totalMinor, 0n)).toBe(3300n);
      expect(lines.reduce((sum, line) => sum + line.dueMinor, 0n)).toBe(3300n);
      // The mixed invoice's usage line needs its exact frozen paid evidence;
      // financial allocations alone cannot authorize a legal usage charge.
      const liability = await db.prisma.billingPaidUsageLiability.create({ data: {
        dispatchId: `mixed-dispatch-${randomUUID()}`,
        receiptId: `mixed-receipt-${randomUUID()}`,
        serviceId: secondService.id, providerServiceId: 'fixture-provider',
        orgId, teamId, userId: ownerId, billingMonth: '2026-05', currency: 'USD',
        tariffId: secondTariff.id, frozenMarkupBps: 3000,
        paymentMode: 'PAY_AS_YOU_GO', rawCostActual: '7.69',
        ratedQuanta: '99970000000000000000000', ratedMicrocredits: 9_997_000_000n,
      } });
      await db.prisma.billingInvoicePaidReceipt.create({ data: {
        invoiceId: invoice.id, serviceId: secondService.id, orgId, teamId,
        billingMonth: '2026-05', dispatchId: liability.dispatchId,
        receiptId: liability.receiptId, ratedMicrocredits: liability.ratedMicrocredits,
        proofSha256: 'e'.repeat(64),
      } });
      await issueBillingInvoice({ invoiceId: invoice.id,
        actor: { email: 'admin@example.com' } }, { prisma: db.prisma, storage,
        now: () => new Date('2026-06-01T00:00:00.000Z'),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
      const source = { kind: 'manual' as const, id: firstTerm.id };
      const quote = { source, serviceId, tariffId, organisationId: orgId, teamId: null,
        scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
        billingMonth: '2026-05', chargeBasis: BillingMonthlyChargeBasis.FLAT,
        seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
        unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
        monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
        baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
        commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null };
      const pending = await prepareBillingCycleClose({ source, billingMonth: '2026-05' }, {
        prisma: db.prisma, now: () => new Date('2026-06-02T00:00:00.000Z'),
        quote: vi.fn().mockResolvedValue(quote),
        discoverTeams: vi.fn().mockResolvedValue({ teamIds: [], snapshot: {
          id: 'mixed-empty', cursor: 'mixed-empty',
          capturedAt: '2026-06-02T00:00:00.000Z', sha256: 'c'.repeat(64),
        } }),
      });
      const captured = await captureIssuedManualBillingCycle({ cycleId: pending.cycleId,
        invoiceId: invoice.id }, { prisma: db.prisma, storage });
      await db.prisma.orgMember.updateMany({ where: { orgId, userId: ownerId },
        data: { role: 'owner' } });
      const detail = await getBillingCycleDetail(context(), captured.cycleId,
        { prisma: db.prisma });
      expect(detail.totals[0]).toMatchObject({ subscription: { amount_minor: '2000' },
        tax: { amount_minor: '200' }, gross_total: { amount_minor: '2200' },
        total_due: { amount_minor: '2200' }, outstanding: { amount_minor: '2200' } });
      await exportBillingConformanceFixture(`${serviceIdentifier}-finalized-taxed-mixed-cycle`, detail);
      expect(detail.documents.map((item) => item.kind))
        .toEqual(['usage_breakdown', 'usage_breakdown']);
      expect(JSON.stringify(detail)).not.toContain(secondService.identifier);
      await db.prisma.billingInvoicePaymentEvent.create({ data: {
        invoiceId: invoice.id, kind: 'PAYMENT', source: 'MANUAL',
        amountMinor: 1000n, currency: 'USD', idempotencyKey: randomUUID(),
        occurredAt: new Date('2026-06-03T00:00:00.000Z'),
      } });
      await expect(refreshIssuedManualBillingCyclePayment({ invoiceId: invoice.id },
        { prisma: db.prisma, storage })).rejects
        .toThrow('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
      await db.prisma.billingInvoicePaymentEvent.create({ data: {
        invoiceId: invoice.id, kind: 'PAYMENT', source: 'MANUAL',
        amountMinor: 2300n, currency: 'USD', idempotencyKey: randomUUID(),
        occurredAt: new Date('2026-06-04T00:00:00.000Z'),
      } });
      const paid = await refreshIssuedManualBillingCyclePayment({ invoiceId: invoice.id },
        { prisma: db.prisma, storage });
      const paidView = await getBillingCycleDetail(context(), paid.cycleId,
        { prisma: db.prisma });
      expect(paidView.totals[0]).toMatchObject({ total_paid: { amount_minor: '2200' },
        outstanding: { amount_minor: '0' } });
      expect(paidView.documents.map((item) => item.kind))
        .toEqual(['usage_breakdown', 'usage_breakdown']);
      await db.prisma.billingInvoicePaymentEvent.create({ data: {
        invoiceId: invoice.id, kind: 'REFUND', source: 'MANUAL',
        amountMinor: 500n, currency: 'USD', idempotencyKey: randomUUID(),
        occurredAt: new Date('2026-06-05T00:00:00.000Z'),
      } });
      const refunded = await refreshIssuedManualBillingCyclePayment({ invoiceId: invoice.id },
        { prisma: db.prisma, storage });
      const refundedView = await getBillingCycleDetail(context(), refunded.cycleId,
        { prisma: db.prisma });
      expect(refundedView.totals[0]).toMatchObject({ total_paid: { amount_minor: '2200' },
        outstanding: { amount_minor: '0' } });
      await db.prisma.$executeRaw`
        UPDATE billing_manual_cycle_reconciliation_queue
        SET due_at = '2030-01-01T00:00:00.000Z'::timestamptz
        WHERE invoice_id = ${invoice.id}
      `;
      await expect(db.prisma.billingInvoiceLineFinancialAllocation.update({
        where: { lineId: secondLine.id }, data: { invoiceCreditMinor: 1n },
      })).rejects.toThrow();
      await expect(db.prisma.billingInvoiceLineFinancialAllocation.delete({
        where: { lineId: secondLine.id },
      })).rejects.toThrow();
      const partial = await db.prisma.billingInvoice.create({ data: {
        orgId, contractId: original.contractId, contractVersionId: version.id,
        issuerProfileId: original.issuerProfileId,
        buyerProfileId: original.buyerProfileId,
        billingMonth: '2026-05', revision: 2, currency: 'USD',
        subtotalMinor: 3000n, taxAmountMinor: 300n,
        creditsAppliedMinor: 0n, totalMinor: 3300n,
        calculationDigest: 'f'.repeat(64),
        issuerSnapshot: original.issuerSnapshot as object,
        buyerSnapshot: original.buyerSnapshot as object,
        lines: { create: [
          { serviceId, serviceIdentifier, serviceName: 'Cycle Issuer Service',
            amountMinor: 2000n, currency: 'USD', position: 1 },
          { serviceId: secondService.id, serviceIdentifier: secondService.identifier,
            serviceName: secondService.name, amountMinor: 1000n,
            currency: 'USD', position: 2 },
        ] },
      }, include: { lines: true } });
      const partialLine = partial.lines.find((line) => line.serviceId === serviceId);
      if (!partialLine) throw new Error('PARTIAL_TEST_LINE_MISSING');
      await expect(db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
        lineId: partialLine.id, invoiceId: partial.id, serviceId,
        billingMonth: '2026-05', subscriptionMinor: 2000n, usageMinor: 0n,
        taxMinor: 200n, invoiceCreditMinor: 0n, totalMinor: 2200n,
        dueMinor: 2200n, currency: 'USD', calculationDigest: 'f'.repeat(64),
      } })).rejects.toThrow();
      expect(await db.prisma.billingInvoiceLineFinancialAllocation.count({
        where: { invoiceId: partial.id },
      })).toBe(0);
    });
}
