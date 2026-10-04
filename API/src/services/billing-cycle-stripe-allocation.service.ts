import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { verifyStripeInvoiceFinancialSource,
  type StripePaymentInvoiceSource } from './billing-customer-invoice-stripe.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { compareBillingCycleUtf8 } from './billing-cycle-binary-order.service.js';

type Reader = PrismaClient | Prisma.TransactionClient;
type Scope = { subscriptionId: string; serviceId: string; orgId: string;
  teamId: string | null; billingMonth: string; currency: string };

/** Exact whole-invoice apportionment; independent of insertion order and locale. */
export function allocateStripeCycleCash(rows: Array<{ id: string; due: bigint }>, paid: bigint) {
  const denominator = rows.reduce((sum, row) => sum + row.due, 0n);
  if (paid < 0n || paid > denominator || rows.some((row) => row.due < 0n) ||
    new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_STRIPE_CASH_UNALLOCATABLE');
  }
  const result = rows.map((row) => ({ id: row.id,
    amount: denominator === 0n ? 0n : row.due * paid / denominator,
    remainder: denominator === 0n ? 0n : row.due * paid % denominator }));
  let remaining = paid - result.reduce((sum, row) => sum + row.amount, 0n);
  result.sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 :
    compareBillingCycleUtf8(a.id, b.id));
  for (const row of result) {
    if (remaining === 0n) break;
    row.amount += 1n;
    remaining -= 1n;
  }
  return new Map(result.map((row) => [row.id, row.amount]));
}

export function stripeCycleAllocationKey(row: StripePaymentInvoiceSource, lineId: string) {
  return createHash('sha256').update(`stripe\0${row.accountId}\0${row.livemode}\0${row.stripeInvoiceId}\0${lineId}`)
    .digest('hex');
}

export async function readStripeCycleFinancialSources(reader: Reader, scope: Scope) {
  const subscription = await reader.billingStripeSubscription.findUniqueOrThrow({
    where: { id: scope.subscriptionId }, include: { customer: true } });
  if (subscription.serviceId !== scope.serviceId || subscription.orgId !== scope.orgId ||
    subscription.teamId !== scope.teamId) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_STRIPE_SOURCE_SCOPE_INVALID');
  }
  const rows = await reader.billingStripePaymentInvoice.findMany({ where: {
    accountId: subscription.accountId, livemode: subscription.livemode,
    orgId: scope.orgId, teamId: scope.teamId,
    lines: { some: { serviceId: scope.serviceId, billingMonth: scope.billingMonth } },
  }, include: { lines: true, subscription: true, cashPayments: true, adjustments: true },
  orderBy: { id: 'asc' } });
  const sources = rows.map((row) => {
    const verified = verifyStripeInvoiceFinancialSource(row);
    if (row.state !== 'ISSUED' || row.currency !== scope.currency ||
      row.stripeCustomerId !== subscription.customer.stripeCustomerId ||
      row.subscription.customerId !== subscription.customerId ||
      row.subscription.scope !== subscription.scope ||
      row.subscription.scopeKey !== subscription.scopeKey) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_STRIPE_LEGAL_SOURCE_PENDING');
    }
    const paidByLine = allocateStripeCycleCash(row.lines.map((line) =>
      ({ id: line.stripeLineId, due: line.dueMinor })), verified.paid);
    const selected = row.lines.filter((line) => line.serviceId === scope.serviceId &&
      line.billingMonth === scope.billingMonth);
    return { row, selected, paidByLine, soleProduct: row.lines.every((line) =>
      line.serviceId === scope.serviceId), fingerprint: billingCycleSnapshotDigest({
      source_digest: row.sourceDigest, invoice_number: row.invoiceNumber,
      issued_at: row.issuedAt?.toISOString(), pdf_key: row.pdfObjectKey, pdf_sha: row.pdfSha256,
      payments: verified.payments.map((payment) => ({ ...payment,
        amount: payment.amount.toString() })),
      refunded: verified.refunded.toString(), disputed: verified.disputed.toString(),
    }, {}) };
  });
  const sum = (field: 'subscriptionMinor' | 'usageMinor' | 'taxMinor' | 'grossMinor' |
    'creditMinor' | 'dueMinor') => sources.reduce((total, source) => total +
      source.selected.reduce((subtotal, line) => subtotal + line[field], 0n), 0n);
  const paid = sources.reduce((sum, source) => sum + source.selected.reduce((total, line) =>
    total + (source.paidByLine.get(line.stripeLineId) ?? 0n), 0n), 0n);
  return { sources, subscription: sum('subscriptionMinor'), usage: sum('usageMinor'),
    tax: sum('taxMinor'), gross: sum('grossMinor'), credits: sum('creditMinor'),
    due: sum('dueMinor'), paid, fingerprint: billingCycleSnapshotDigest(
      sources.map((source) => ({ id: source.row.id, fingerprint: source.fingerprint })), {}) };
}
