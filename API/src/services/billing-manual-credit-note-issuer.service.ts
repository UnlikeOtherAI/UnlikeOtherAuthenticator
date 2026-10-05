import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor } from './billing-admin-effect-authority.service.js';
import { invoiceSourceFingerprint } from
  './billing-cycle-manual-invoice.service.js';
import { renderManualCreditNotePdf } from './billing-manual-credit-note-pdf.service.js';
import { createBillingInvoicePdfStorage, type BillingInvoicePdfStorage } from
  './billing-invoice-storage.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

const invoiceInclude = { lines: true, paymentEvents: true,
  lineFinancialAllocations: true, creditSettlementRefs: true,
  lineCreditAllocations: true } as const;

export async function issueManualCreditNote(params: {
  creditNoteId: string; actor: BillingAdminEffectActor;
}, deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage;
  now?: () => Date }): Promise<{ id: string; status: string; number: string;
  pdfSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const now = deps?.now?.() ?? new Date();
  const claimed = await prisma.$transaction(async (tx) => {
    await lockBillingAdminEffectAuthority(tx, params.actor);
    const note = await tx.billingManualCreditNote.findUnique({ where: {
      id: params.creditNoteId,
    }, include: { issuerProfile: {
      select: { invoiceNumberPrefix: true, active: true } } } });
    if (!note) hold('BILLING_MANUAL_CREDIT_NOTE_MISSING');
    if (note.status === 'ISSUED' || note.status === 'ISSUING') return note;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${note.orgId} FOR UPDATE`);
    const invoice = await tx.billingInvoice.findUnique({ where: {
      id: note.originalInvoiceId,
    }, include: invoiceInclude });
    const latest = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: note.serviceId, orgId: note.orgId, teamId: null,
      billingMonth: note.billingMonth,
    }, orderBy: { revision: 'desc' }, select: { id: true } });
    if (!invoice || invoice.status !== 'ISSUED' || invoice.voidedAt ||
      !invoice.invoiceNumber || !note.issuerProfile.active ||
      latest?.id !== note.originalCycleId ||
      invoiceSourceFingerprint(invoice) !== note.originalSourceDigest) {
      hold('BILLING_MANUAL_CREDIT_NOTE_SOURCE_CHANGED');
    }
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const sequence = await tx.billingInvoiceNumberSequence.upsert({ where: {
      issuerProfileId_year: { issuerProfileId: note.issuerProfileId,
        year: day.getUTCFullYear() },
    }, create: { issuerProfileId: note.issuerProfileId, year: day.getUTCFullYear(),
      lastValue: 1n }, update: { lastValue: { increment: 1n } } });
    const number = `CN-${note.issuerProfile.invoiceNumberPrefix}-${day.getUTCFullYear()}-${sequence.lastValue.toString().padStart(6, '0')}`;
    return tx.billingManualCreditNote.update({ where: { id: note.id }, data: {
      status: 'ISSUING', creditNoteNumber: number, issueDate: day,
    }, include: { issuerProfile: {
      select: { invoiceNumberPrefix: true, active: true } } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (claimed.status === 'ISSUED') {
    return { id: claimed.id, status: claimed.status,
      number: claimed.creditNoteNumber ?? hold('BILLING_MANUAL_CREDIT_NOTE_NUMBER_MISSING'),
      pdfSha256: claimed.pdfSha256 ?? hold('BILLING_MANUAL_CREDIT_NOTE_PDF_MISSING') };
  }
  const original = await prisma.billingInvoice.findUnique({ where: {
    id: claimed.originalInvoiceId,
  }, include: invoiceInclude });
  if (!original || original.status !== 'ISSUED' || !original.invoiceNumber ||
    invoiceSourceFingerprint(original) !== claimed.originalSourceDigest ||
    !claimed.creditNoteNumber || !claimed.issueDate) {
    hold('BILLING_MANUAL_CREDIT_NOTE_SOURCE_CHANGED');
  }
  const objectKey = `billing-invoices/${claimed.orgId}/credit-notes/${claimed.id}.pdf`;
  let bytes: Buffer;
  try {
    bytes = await storage.read(objectKey);
  } catch (error) {
    if (!(error instanceof AppError) || error.message !== 'BILLING_INVOICE_PDF_NOT_FOUND') {
      throw error;
    }
    const generated = await renderManualCreditNotePdf({ number: claimed.creditNoteNumber,
      issuedAt: claimed.issueDate, originalInvoiceNumber: original.invoiceNumber,
      billingMonth: claimed.billingMonth, currency: claimed.currency,
      netMinor: claimed.netCreditMinor, taxMinor: claimed.taxCreditMinor,
      issuerSnapshot: claimed.issuerSnapshot as Record<string, unknown>,
      buyerSnapshot: claimed.buyerSnapshot as Record<string, unknown> });
    try {
      await storage.putImmutable(objectKey, generated, 'application/pdf');
    } catch (writeError) {
      if (!(writeError instanceof AppError) ||
        writeError.message !== 'BILLING_INVOICE_PDF_ALREADY_EXISTS') throw writeError;
    }
    bytes = await storage.read(objectKey);
  }
  if (bytes.length < 5 || bytes.length > 20 * 1024 * 1024 ||
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    hold('BILLING_MANUAL_CREDIT_NOTE_DOCUMENT_CHANGED');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${claimed.orgId} FOR UPDATE`);
    const current = await tx.billingManualCreditNote.findUnique({ where: {
      id: claimed.id,
    } });
    const source = await tx.billingInvoice.findUnique({ where: {
      id: claimed.originalInvoiceId,
    }, include: invoiceInclude });
    if (!current || !source || source.status !== 'ISSUED' || source.voidedAt ||
    invoiceSourceFingerprint(source) !== claimed.originalSourceDigest ||
      current.creditNoteNumber !== claimed.creditNoteNumber ||
      current.issueDate?.getTime() !== claimed.issueDate?.getTime()) {
      hold('BILLING_MANUAL_CREDIT_NOTE_SOURCE_CHANGED');
    }
    const recorded = await storage.read(objectKey);
    if (recorded.length !== bytes.length ||
      createHash('sha256').update(recorded).digest('hex') !== sha256) {
      hold('BILLING_MANUAL_CREDIT_NOTE_DOCUMENT_CHANGED');
    }
    if (current.status === 'ISSUED') {
      if (current.pdfSha256 !== sha256) hold('BILLING_MANUAL_CREDIT_NOTE_REPLAY_CHANGED');
    } else if (current.status === 'ISSUING') {
      await tx.billingManualCreditNote.update({ where: { id: current.id }, data: {
        status: 'ISSUED', pdfObjectKey: objectKey,
        pdfSha256: sha256, issuedAt: now,
      } });
      await tx.adminAuditLog.create({ data: { actorEmail: params.actor.email,
        action: 'billing.manual_credit_note_issued', metadata: {
          credit_note_id: current.id, original_invoice_id: current.originalInvoiceId,
          pdf_sha256: sha256,
        } } });
    } else hold('BILLING_MANUAL_CREDIT_NOTE_STATE_CHANGED');
    return { id: current.id, status: 'ISSUED', number: claimed.creditNoteNumber ?? '',
      pdfSha256: sha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function getManualCreditNoteForInvoice(invoiceId: string,
  deps?: { prisma?: PrismaClient }) {
  return (deps?.prisma ?? getAdminPrisma()).billingManualCreditNote.findUnique({
    where: { originalInvoiceId: invoiceId },
  });
}

export async function readManualCreditNotePdf(creditNoteId: string,
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage }):
Promise<{ value: Buffer; filename: string }> {
  const note = await (deps?.prisma ?? getAdminPrisma()).billingManualCreditNote.findUnique({
    where: { id: creditNoteId },
  });
  if (!note || note.status !== 'ISSUED' || !note.pdfObjectKey ||
    !note.pdfSha256 || !note.creditNoteNumber) hold('BILLING_MANUAL_CREDIT_NOTE_UNAVAILABLE');
  const value = await (deps?.storage ?? createBillingInvoicePdfStorage()).read(note.pdfObjectKey);
  if (value.length < 5 || value.length > 20 * 1024 * 1024 ||
    value.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    createHash('sha256').update(value).digest('hex') !== note.pdfSha256) {
    hold('BILLING_MANUAL_CREDIT_NOTE_DOCUMENT_CHANGED');
  }
  return { value, filename: `${note.creditNoteNumber}.pdf` };
}
