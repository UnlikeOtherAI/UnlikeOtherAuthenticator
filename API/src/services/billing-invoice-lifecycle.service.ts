import { createHash } from 'node:crypto';

import {
  BillingInvoicePaymentEventKind,
  BillingInvoicePaymentEventSource,
  BillingInvoiceStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor,
} from './billing-admin-effect-authority.service.js';
import {
  billingInvoicePdfTemplateVersion,
  generateBillingInvoicePdf,
} from './billing-invoice-pdf.service.js';
import {
  createBillingInvoicePdfStorage,
  type BillingInvoicePdfStorage,
} from './billing-invoice-storage.service.js';
import type { CustomerSafeInvoice } from './billing-invoice-view.service.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const invoiceInclude = Prisma.validator<Prisma.BillingInvoiceInclude>()({
  lines: { orderBy: { position: 'asc' } },
  addonLines: { orderBy: { position: 'asc' } },
  paymentEvents: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
  issuerProfile: { select: { active: true } },
  _count: { select: { creditSettlementRefs: true } },
});

type Actor = BillingAdminEffectActor;
type LifecycleDeps = {
  prisma?: PrismaClient;
  storage?: BillingInvoicePdfStorage;
  now?: () => Date;
  generatePdf?: typeof generateBillingInvoicePdf;
  authorizeAdminEffect?: typeof lockBillingAdminEffectAuthority;
};

function client(deps?: LifecycleDeps): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function isTransactionConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034'),
  );
}

async function withConflictRetries<T>(
  operation: () => Promise<T>,
  exhaustedMessage: string,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      if (attempt === 2) throw new AppError('BAD_REQUEST', 409, exhaustedMessage);
    }
  }
  throw new AppError('BAD_REQUEST', 409, exhaustedMessage);
}

export async function listBillingInvoices(
  params?: {
    organisationId?: string;
    contractId?: string;
    billingMonth?: string;
    status?: BillingInvoiceStatus;
  },
  deps?: { prisma?: PrismaClient },
) {
  return (deps?.prisma ?? getAdminPrisma()).billingInvoice.findMany({
    where: {
      ...(params?.organisationId ? { orgId: params.organisationId } : {}),
      ...(params?.contractId ? { contractId: params.contractId } : {}),
      ...(params?.billingMonth ? { billingMonth: params.billingMonth } : {}),
      ...(params?.status ? { status: params.status } : {}),
    },
    include: invoiceInclude,
    orderBy: [{ billingMonth: 'desc' }, { revision: 'desc' }, { id: 'desc' }],
  });
}

export async function getBillingInvoice(invoiceId: string, deps?: { prisma?: PrismaClient }) {
  const invoice = await (deps?.prisma ?? getAdminPrisma()).billingInvoice.findUnique({
    where: { id: invoiceId },
    include: invoiceInclude,
  });
  if (!invoice) throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_NOT_FOUND');
  return invoice;
}

function issueDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dueDate(issue: Date, days: number): Date {
  return new Date(issue.getTime() + days * 24 * 60 * 60 * 1000);
}

async function claimForIssue(
  invoiceId: string,
  actor: Actor,
  now: Date,
  prisma: PrismaClient,
  authorizeAdminEffect: typeof lockBillingAdminEffectAuthority,
) {
  return prisma.$transaction(
    async (tx) => {
      await authorizeAdminEffect(tx, actor);
      const invoice = await tx.billingInvoice.findUnique({
        where: { id: invoiceId },
        include: {
          ...invoiceInclude,
          contractVersion: { select: { paymentTermsDays: true } },
          issuerProfile: { select: { invoiceNumberPrefix: true, active: true } },
        },
      });
      if (!invoice) throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_NOT_FOUND');
      if (invoice.status === BillingInvoiceStatus.ISSUED) return invoice;
      if (invoice.status === BillingInvoiceStatus.VOID) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_VOID');
      }
      if (invoice.status === BillingInvoiceStatus.ISSUING) {
        if (!invoice.invoiceNumber || !invoice.issueDate || !invoice.dueDate) {
          throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_ISSUE_STATE_INVALID');
        }
        return invoice;
      }
      if (!invoice.issuerProfile.active) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_ISSUER_INACTIVE');
      }
      const issue = issueDay(now);
      const sequence = await tx.billingInvoiceNumberSequence.upsert({
        where: {
          issuerProfileId_year: {
            issuerProfileId: invoice.issuerProfileId,
            year: issue.getUTCFullYear(),
          },
        },
        create: {
          issuerProfileId: invoice.issuerProfileId,
          year: issue.getUTCFullYear(),
          lastValue: 1n,
        },
        update: { lastValue: { increment: 1n } },
      });
      const invoiceNumber = `${invoice.issuerProfile.invoiceNumberPrefix}-${issue.getUTCFullYear()}-${sequence.lastValue.toString().padStart(6, '0')}`;
      const claimed = await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          status: BillingInvoiceStatus.ISSUING,
          invoiceNumber,
          issueDate: issue,
          dueDate: dueDate(issue, invoice.contractVersion.paymentTermsDays),
        },
        include: invoiceInclude,
      });
      await tx.adminAuditLog.create({
        data: {
          actorEmail: actor.email,
          action: 'billing.invoice_issue_claimed',
          metadata: { invoice_id: invoice.id, invoice_number: invoiceNumber },
        },
      });
      return claimed;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function storePdf(
  storage: BillingInvoicePdfStorage,
  key: string,
  pdf: Uint8Array,
): Promise<string> {
  const expected = createHash('sha256').update(pdf).digest('hex');
  try {
    await storage.putImmutable(key, pdf);
  } catch (error) {
    if (!(error instanceof AppError) || error.message !== 'BILLING_INVOICE_PDF_ALREADY_EXISTS') {
      throw error;
    }
    const existing = await storage.read(key);
    if (createHash('sha256').update(existing).digest('hex') !== expected) {
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_PDF_IMMUTABILITY_CONFLICT');
    }
  }
  return expected;
}

export async function issueBillingInvoice(
  params: { invoiceId: string; actor: Actor },
  deps?: LifecycleDeps,
) {
  const prisma = client(deps);
  const now = deps?.now?.() ?? new Date();
  const claimed = await withConflictRetries(
    () =>
      claimForIssue(
        params.invoiceId,
        params.actor,
        now,
        prisma,
        deps?.authorizeAdminEffect ?? lockBillingAdminEffectAuthority,
      ),
    'BILLING_INVOICE_ISSUE_BUSY',
  );
  if (claimed.status === BillingInvoiceStatus.ISSUED) return claimed;
  const pdf = await (deps?.generatePdf ?? generateBillingInvoicePdf)(
    claimed as CustomerSafeInvoice,
  );
  const objectKey = `billing-invoices/${claimed.orgId}/${claimed.id}.pdf`;
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const pdfSha256 = await storePdf(storage, objectKey, pdf);
  const result = await withConflictRetries(
    () =>
      prisma.$transaction(
        async (tx) => {
          const updated = await tx.billingInvoice.updateMany({
            where: { id: claimed.id, status: BillingInvoiceStatus.ISSUING },
            data: {
              status: BillingInvoiceStatus.ISSUED,
              pdfObjectKey: objectKey,
              pdfSha256,
              pdfTemplateVersion: billingInvoicePdfTemplateVersion(),
              issuedAt: now,
            },
          });
          if (updated.count === 1) {
            await tx.adminAuditLog.create({
              data: {
                actorEmail: params.actor.email,
                action: 'billing.invoice_issued',
                metadata: {
                  invoice_id: claimed.id,
                  invoice_number: claimed.invoiceNumber,
                  pdf_sha256: pdfSha256,
                },
              },
            });
          }
          const invoice = await tx.billingInvoice.findUnique({
            where: { id: claimed.id },
            include: invoiceInclude,
          });
          if (
            !invoice ||
            invoice.status !== BillingInvoiceStatus.ISSUED ||
            invoice.pdfSha256 !== pdfSha256 ||
            invoice.pdfObjectKey !== objectKey
          ) {
            throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_ISSUE_CONFLICT');
          }
          return invoice;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    'BILLING_INVOICE_ISSUE_BUSY',
  );
  return result;
}

export async function readBillingInvoicePdf(
  invoiceId: string,
  deps?: Pick<LifecycleDeps, 'prisma' | 'storage'>,
): Promise<{ value: Buffer; filename: string }> {
  const invoice = await (deps?.prisma ?? getAdminPrisma()).billingInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      status: true,
      invoiceNumber: true,
      pdfObjectKey: true,
      pdfSha256: true,
    },
  });
  if (
    !invoice ||
    (invoice.status !== BillingInvoiceStatus.ISSUED &&
      invoice.status !== BillingInvoiceStatus.VOID) ||
    !invoice.invoiceNumber ||
    !invoice.pdfObjectKey ||
    !invoice.pdfSha256
  ) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_PDF_NOT_FOUND');
  }
  const value = await (deps?.storage ?? createBillingInvoicePdfStorage()).read(
    invoice.pdfObjectKey,
  );
  if (createHash('sha256').update(value).digest('hex') !== invoice.pdfSha256) {
    throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_PDF_INTEGRITY_FAILED');
  }
  return { value, filename: `${invoice.invoiceNumber}.pdf` };
}

export async function voidBillingInvoice(
  params: { invoiceId: string; reason: string; actor: Actor },
  deps?: Pick<LifecycleDeps, 'prisma' | 'now' | 'authorizeAdminEffect'>,
) {
  const reason = params.reason.trim();
  if (!reason || reason.length > 500) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_VOID_REASON_INVALID');
  }
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.$transaction(async (tx) => {
    await (deps?.authorizeAdminEffect ?? lockBillingAdminEffectAuthority)(tx, params.actor);
    const invoice = await tx.billingInvoice.findUnique({
      where: { id: params.invoiceId },
      include: invoiceInclude,
    });
    if (!invoice) throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_NOT_FOUND');
    if (invoice.status === BillingInvoiceStatus.VOID) return invoice;
    if (
      invoice.status !== BillingInvoiceStatus.ISSUED ||
      invoice._count.creditSettlementRefs > 0 ||
      invoice.paymentEvents.length > 0
    ) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_VOID_FORBIDDEN');
    }
    const updated = await tx.billingInvoice.update({
      where: { id: invoice.id },
      data: {
        status: BillingInvoiceStatus.VOID,
        voidedAt: deps?.now?.() ?? new Date(),
        voidReason: reason,
      },
      include: invoiceInclude,
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.invoice_voided',
        metadata: { invoice_id: invoice.id, reason },
      },
    });
    return updated;
  });
}

function paymentKind(value: 'payment' | 'refund' | 'write_off'): BillingInvoicePaymentEventKind {
  if (value === 'refund') return BillingInvoicePaymentEventKind.REFUND;
  if (value === 'write_off') return BillingInvoicePaymentEventKind.WRITE_OFF;
  return BillingInvoicePaymentEventKind.PAYMENT;
}

function totals(events: Array<{ kind: BillingInvoicePaymentEventKind; amountMinor: bigint }>) {
  return events.reduce(
    (value, event) => {
      if (event.kind === BillingInvoicePaymentEventKind.PAYMENT)
        value.payments += event.amountMinor;
      if (event.kind === BillingInvoicePaymentEventKind.REFUND) value.refunds += event.amountMinor;
      if (event.kind === BillingInvoicePaymentEventKind.WRITE_OFF)
        value.writeOffs += event.amountMinor;
      return value;
    },
    { payments: 0n, refunds: 0n, writeOffs: 0n },
  );
}

export async function recordBillingInvoicePayment(
  params: {
    invoiceId: string;
    kind: 'payment' | 'refund' | 'write_off';
    amountMinor: string;
    currency: string;
    idempotencyKey: string;
    reference?: string | null;
    occurredAt: Date;
    actor: Actor;
  },
  deps?: Pick<LifecycleDeps, 'prisma' | 'now' | 'authorizeAdminEffect'>,
) {
  let amount: bigint;
  try {
    amount = BigInt(params.amountMinor);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_PAYMENT_INVALID');
  }
  const currency = params.currency.trim().toUpperCase();
  const idempotencyKey = params.idempotencyKey.trim();
  const reference = params.reference?.trim() || null;
  const now = deps?.now?.() ?? new Date();
  if (
    !/^[1-9]\d*$/.test(params.amountMinor) ||
    amount > MAX_INT64 ||
    !/^[A-Z]{3}$/.test(currency) ||
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    (reference?.length ?? 0) > 255 ||
    Number.isNaN(params.occurredAt.getTime()) ||
    params.occurredAt.getTime() > now.getTime() + 5 * 60 * 1000
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_PAYMENT_INVALID');
  }
  const kind = paymentKind(params.kind);
  const prisma = deps?.prisma ?? getAdminPrisma();
  return withConflictRetries(
    () =>
      prisma.$transaction(
        async (tx) => {
          await (deps?.authorizeAdminEffect ?? lockBillingAdminEffectAuthority)(tx, params.actor);
          const invoice = await tx.billingInvoice.findUnique({
            where: { id: params.invoiceId },
            include: invoiceInclude,
          });
          if (!invoice) throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_NOT_FOUND');
          if (
            invoice.status !== BillingInvoiceStatus.ISSUED ||
            invoice.currency !== currency ||
            !invoice.issuedAt ||
            params.occurredAt < invoice.issuedAt
          ) {
            throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_PAYMENT_FORBIDDEN');
          }
          const existing = invoice.paymentEvents.find(
            (event) => event.idempotencyKey === idempotencyKey,
          );
          if (existing) {
            if (
              existing.kind !== kind ||
              existing.amountMinor !== amount ||
              existing.currency !== currency ||
              existing.reference !== reference ||
              existing.occurredAt.getTime() !== params.occurredAt.getTime()
            ) {
              throw new AppError(
                'BAD_REQUEST',
                409,
                'BILLING_INVOICE_PAYMENT_IDEMPOTENCY_CONFLICT',
              );
            }
            return invoice;
          }
          const current = totals(invoice.paymentEvents);
          const next = { ...current };
          if (kind === BillingInvoicePaymentEventKind.PAYMENT) next.payments += amount;
          if (kind === BillingInvoicePaymentEventKind.REFUND) next.refunds += amount;
          if (kind === BillingInvoicePaymentEventKind.WRITE_OFF) next.writeOffs += amount;
          const paid = next.payments - next.refunds;
          const settled = invoice.creditsAppliedMinor + paid + next.writeOffs;
          if (paid < 0n || settled < 0n || settled > invoice.totalMinor) {
            throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_PAYMENT_AMOUNT_INVALID');
          }
          await tx.billingInvoicePaymentEvent.create({
            data: {
              invoiceId: invoice.id,
              kind,
              source: BillingInvoicePaymentEventSource.MANUAL,
              amountMinor: amount,
              currency,
              idempotencyKey,
              reference,
              occurredAt: params.occurredAt,
              createdByUserId: params.actor.userId ?? null,
              createdByEmail: params.actor.email,
            },
          });
          await tx.adminAuditLog.create({
            data: {
              actorEmail: params.actor.email,
              action: 'billing.invoice_payment_recorded',
              metadata: {
                invoice_id: invoice.id,
                kind: kind.toLowerCase(),
                amount_minor: amount.toString(),
                currency,
              },
            },
          });
          const updated = await tx.billingInvoice.findUnique({
            where: { id: invoice.id },
            include: invoiceInclude,
          });
          if (!updated) throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_NOT_FOUND');
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    'BILLING_INVOICE_PAYMENT_BUSY',
  );
}
