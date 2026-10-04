import { createHash } from 'node:crypto';

import {
  BillingAssignmentScope, BillingInvoiceStatus, type PrismaClient,
} from '@prisma/client';

import {
  type BillingCustomerInvoiceDetailV1, type BillingCustomerInvoiceSummaryV1,
  type BillingCustomerInvoicesListV1,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingCycleContext } from './billing-cycle-read.service.js';
import { authorizeBillingCycle } from './billing-cycle-authority.service.js';
import { createBillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import {
  projectManualCustomerInvoiceDetail, projectManualCustomerInvoiceSummary,
} from './billing-customer-invoice-manual.service.js';
import {
  projectPrepaidCustomerInvoiceDetail, projectPrepaidCustomerInvoiceSummary,
} from './billing-customer-invoice-prepaid.service.js';

type Storage = ReturnType<typeof createBillingInvoicePdfStorage>;
type SourceKind = 'manual' | 'prepaid';
type Cursor = { at: string; kind: SourceKind; id: string };
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function notFound(): never {
  throw new AppError('NOT_FOUND', 404, 'BILLING_CUSTOMER_INVOICE_NOT_FOUND');
}

function subject(context: BillingCycleContext) {
  return { product: context.request.product,
    organisation_id: context.request.organisationId,
    team_id: context.request.teamId, user_id: context.request.userId };
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  if (value.length > 256) throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_CURSOR_INVALID');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (typeof parsed !== 'object' || parsed === null ||
      typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at)) ||
      new Date(parsed.at).toISOString() !== parsed.at ||
      (parsed.kind !== 'manual' && parsed.kind !== 'prepaid') ||
      typeof parsed.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed.id) ||
      Buffer.from(JSON.stringify(parsed)).toString('base64url') !== value) throw new Error();
    return parsed;
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_CURSOR_INVALID');
  }
}

function encodeCursor(item: { at: string; kind: SourceKind; id: string }): string {
  return Buffer.from(JSON.stringify(item)).toString('base64url');
}

function inMonth(month: string): { start: Date; end: Date } {
  if (!monthPattern.test(month)) throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_MONTH_INVALID');
  const start = new Date(`${month}-01T00:00:00.000Z`);
  return { start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
}

function order(a: { at: string; kind: SourceKind; id: string },
  b: { at: string; kind: SourceKind; id: string }): number {
  return b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) ||
    Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));
}

function afterCursor(item: Cursor, cursor: Cursor | null): boolean {
  return !cursor || order(item, cursor) > 0;
}

function sourceId(invoiceId: string): { kind: SourceKind; id: string } {
  const matched = /^(manual|prepaid):([a-zA-Z0-9_-]{1,128})$/.exec(invoiceId);
  if (!matched) notFound();
  return { kind: matched[1] as SourceKind, id: matched[2] ?? notFound() };
}

async function prepaidAdjustments(prisma: PrismaClient, rows: Array<{
  accountId: string; stripePaymentIntentId: string;
}>) {
  if (rows.length === 0) return [];
  return prisma.billingCreditPaymentAdjustment.findMany({ where: { OR: rows.map((row) => ({
    accountId: row.accountId, stripePaymentIntentId: row.stripePaymentIntentId,
  })) }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
}

export async function listCustomerInvoices(
  context: BillingCycleContext, params: { chargeMonth: string; limit?: number; cursor?: string },
  deps?: { prisma?: PrismaClient; now?: Date },
): Promise<BillingCustomerInvoicesListV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const viewer = await authorizeBillingCycle(context, { prisma });
  const orgManager = viewer.organisationRole === 'owner' || viewer.organisationRole === 'admin';
  const { start, end } = inMonth(params.chargeMonth);
  const limit = params.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_LIMIT_INVALID');
  }
  const cursor = decodeCursor(params.cursor);
  const cursorDate = cursor ? new Date(cursor.at) : null;
  const manual = orgManager ? await prisma.billingInvoice.findMany({ where: {
    orgId: context.request.organisationId,
    status: { in: [BillingInvoiceStatus.ISSUED, BillingInvoiceStatus.VOID] },
    issuedAt: { gte: start, lt: end },
    ...(cursorDate ? { OR: [
      { issuedAt: { lt: cursorDate } },
      ...(cursor?.kind === 'manual' ? [
        { issuedAt: cursorDate, id: { lt: cursor.id } },
      ] : []),
    ] } : {}),
    lines: { some: { serviceIdentifier: context.request.product },
      every: { serviceIdentifier: context.request.product } },
  }, include: { lines: true, paymentEvents: true },
  orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], take: limit + 1 }) : [];
  const prepaid = await prisma.billingCreditPaymentInvoice.findMany({ where: {
    orgId: context.request.organisationId,
    serviceId: context.credential.service.id,
    paidAt: { gte: start, lt: end },
    AND: [
      { OR: orgManager ? [{ teamId: context.request.teamId }, { teamId: null }] :
        [{ teamId: context.request.teamId }] },
      ...(cursorDate ? [{ OR: [
        { paidAt: { lt: cursorDate } },
        ...(cursor?.kind === 'manual' ? [{ paidAt: cursorDate }] : [
          { paidAt: cursorDate, id: { lt: cursor?.id ?? '' } },
        ]),
      ] }] : []),
    ],
  }, include: { creditEntry: true, autoAttempt: { select: { id: true, currency: true } } },
  orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  const changes = await prepaidAdjustments(prisma, prepaid);
  const results: Array<{ key: Cursor; summary: BillingCustomerInvoiceSummaryV1 }> = [
    ...manual.map((row) => ({ key: { at: row.issuedAt?.toISOString() ?? notFound(), kind: 'manual' as const,
      id: row.id }, summary: projectManualCustomerInvoiceSummary(row) })),
    ...prepaid.map((row) => ({ key: { at: row.paidAt.toISOString(), kind: 'prepaid' as const,
      id: row.id }, summary: projectPrepaidCustomerInvoiceSummary(row,
      changes.filter((change) => change.accountId === row.accountId &&
        change.stripePaymentIntentId === row.stripePaymentIntentId), context.request.product) })),
  ];
  const selected = results.filter((item) => afterCursor(item.key, cursor))
    .sort((a, b) => order(a.key, b.key));
  const page = selected.slice(0, limit);
  const last = page.at(-1);
  return { schema_version: 1, generated_at: (deps?.now ?? new Date()).toISOString(),
    subject: subject(context), charge_month: params.chargeMonth,
    invoices: page.map((item) => item.summary),
    next_cursor: selected.length > limit && last ? encodeCursor(last.key) : null };
}

async function readCustomerInvoice(
  context: BillingCycleContext, invoiceId: string, prisma: PrismaClient,
): Promise<{ detail: BillingCustomerInvoiceDetailV1; pdfKey: string | null; sha256: string | null }> {
  await authorizeBillingCycle(context, { prisma });
  const source = sourceId(invoiceId);
  if (source.kind === 'manual') {
    const row = await prisma.billingInvoice.findFirst({ where: { id: source.id,
      orgId: context.request.organisationId,
      status: { in: [BillingInvoiceStatus.ISSUED, BillingInvoiceStatus.VOID] },
      lines: { some: { serviceIdentifier: context.request.product },
        every: { serviceIdentifier: context.request.product } },
    }, include: { lines: true, paymentEvents: true } });
    if (!row) notFound();
    await authorizeBillingCycle({ ...context, payerScope: BillingAssignmentScope.ORGANISATION },
      { prisma });
    return { detail: projectManualCustomerInvoiceDetail(row, subject(context)),
      pdfKey: row.pdfObjectKey, sha256: row.pdfSha256 };
  }
  const row = await prisma.billingCreditPaymentInvoice.findFirst({ where: {
    id: source.id, orgId: context.request.organisationId,
    serviceId: context.credential.service.id,
    OR: [{ teamId: context.request.teamId }, { teamId: null }],
  }, include: { creditEntry: true, autoAttempt: { select: { id: true, currency: true } } } });
  if (!row) notFound();
  if (row.teamId === null) {
    await authorizeBillingCycle({ ...context, payerScope: BillingAssignmentScope.ORGANISATION },
      { prisma });
  }
  const changes = await prepaidAdjustments(prisma, [row]);
  return { detail: projectPrepaidCustomerInvoiceDetail(row, changes,
    context.request.product, subject(context)),
  pdfKey: row.pdfObjectKey, sha256: row.pdfSha256 };
}

export async function getCustomerInvoiceDetail(
  context: BillingCycleContext, invoiceId: string, deps?: { prisma?: PrismaClient },
): Promise<BillingCustomerInvoiceDetailV1> {
  return (await readCustomerInvoice(context, invoiceId, deps?.prisma ?? getAdminPrisma())).detail;
}

export async function downloadCustomerInvoice(
  context: BillingCycleContext, invoiceId: string, documentId: string,
  deps?: { prisma?: PrismaClient; storage?: Storage },
): Promise<{ bytes: Buffer; contentType: 'application/pdf'; filename: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (invoiceId !== documentId) notFound();
  const before = await readCustomerInvoice(context, invoiceId, prisma);
  if (!before.detail.document || !before.pdfKey || !before.sha256) notFound();
  const bytes = await (deps?.storage ?? createBillingInvoicePdfStorage()).read(before.pdfKey);
  if (bytes.length < 5 || bytes.length > 20 * 1024 * 1024 ||
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    createHash('sha256').update(bytes).digest('hex') !== before.sha256) {
    throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_INVOICE_DOCUMENT_INTEGRITY');
  }
  // The storage read can outlive the actor's membership or billing role.
  const after = await readCustomerInvoice(context, invoiceId, prisma);
  if (!after.detail.document || after.pdfKey !== before.pdfKey ||
    after.sha256 !== before.sha256 ||
    after.detail.number !== before.detail.number ||
    after.detail.scope.scope_type !== before.detail.scope.scope_type ||
    JSON.stringify(after.detail.totals) !== JSON.stringify(before.detail.totals)) {
    throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_INVOICE_DOCUMENT_REBOUND');
  }
  return { bytes, contentType: 'application/pdf',
    filename: `invoice-${after.detail.number?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? 'document'}.pdf` };
}
