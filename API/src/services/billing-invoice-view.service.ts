import type {
  BillingInvoicePaymentEventKind,
  BillingInvoicePaymentEventSource,
  BillingInvoiceStatus,
  Prisma,
} from '@prisma/client';

import { exactMoney, minorAmountToMajor } from './billing-money.service.js';

type InvoiceLineValue = {
  id: string;
  serviceIdentifier: string;
  serviceName: string;
  amountMinor: bigint;
  currency: string;
  position: number;
};

type PaymentEventValue = {
  id: string;
  kind: BillingInvoicePaymentEventKind;
  source: BillingInvoicePaymentEventSource;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
  occurredAt: Date;
  createdAt: Date;
};

export type CustomerSafeInvoice = {
  id: string;
  orgId: string;
  contractId: string;
  contractVersionId: string;
  billingMonth: string;
  revision: number;
  status: BillingInvoiceStatus;
  invoiceNumber: string | null;
  issueDate: Date | null;
  dueDate: Date | null;
  currency: string;
  subtotalMinor: bigint;
  taxAmountMinor: bigint;
  totalMinor: bigint;
  creditsAppliedMinor: bigint;
  issuerSnapshot: Prisma.JsonValue;
  buyerSnapshot: Prisma.JsonValue;
  issuedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
  lines: InvoiceLineValue[];
  paymentEvents: PaymentEventValue[];
};

function money(amountMinor: bigint, currency: string) {
  const amount = minorAmountToMajor(amountMinor.toString(), currency);
  return { amount_minor: amountMinor.toString(), ...exactMoney(amount, currency) };
}

function partySnapshot(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    'profile_id',
    'legal_name',
    'trading_name',
    'billing_email',
    'address',
    'billing_address',
    'tax_identifier',
    'company_registration_number',
    'purchase_order_reference',
  ];
  return Object.fromEntries(
    allowed.filter((key) => key in source).map((key) => [key, source[key]]),
  );
}

export function invoiceSettlement(invoice: CustomerSafeInvoice) {
  let payments = 0n;
  let refunds = 0n;
  let writeOffs = 0n;
  for (const event of invoice.paymentEvents) {
    if (event.kind === 'PAYMENT') payments += event.amountMinor;
    if (event.kind === 'REFUND') refunds += event.amountMinor;
    if (event.kind === 'WRITE_OFF') writeOffs += event.amountMinor;
  }
  const paid = payments - refunds;
  const settled = invoice.creditsAppliedMinor + paid + writeOffs;
  const outstanding = invoice.totalMinor > settled ? invoice.totalMinor - settled : 0n;
  const status =
    invoice.status === 'VOID'
      ? 'void'
      : outstanding === 0n
        ? 'paid'
        : settled > 0n
          ? 'partially_paid'
          : 'open';
  return {
    payments,
    refunds,
    writeOffs,
    creditsApplied: invoice.creditsAppliedMinor,
    paid,
    settled,
    outstanding,
    status,
  };
}

export function serializeCustomerSafeInvoice(invoice: CustomerSafeInvoice) {
  const settlement = invoiceSettlement(invoice);
  return {
    id: invoice.id,
    organisation_id: invoice.orgId,
    contract_id: invoice.contractId,
    contract_version_id: invoice.contractVersionId,
    billing_month: invoice.billingMonth,
    revision: invoice.revision,
    status: invoice.status.toLowerCase(),
    invoice_number: invoice.invoiceNumber,
    issue_date: invoice.issueDate?.toISOString() ?? null,
    due_date: invoice.dueDate?.toISOString() ?? null,
    issued_at: invoice.issuedAt?.toISOString() ?? null,
    voided_at: invoice.voidedAt?.toISOString() ?? null,
    void_reason: invoice.voidReason,
    currency: invoice.currency,
    issuer: partySnapshot(invoice.issuerSnapshot),
    buyer: partySnapshot(invoice.buyerSnapshot),
    lines: [...invoice.lines]
      .sort((left, right) => left.position - right.position)
      .map((line) => ({
        id: line.id,
        service: {
          identifier: line.serviceIdentifier,
          name: line.serviceName,
        },
        price: money(line.amountMinor, line.currency),
      })),
    totals: {
      subtotal: money(invoice.subtotalMinor, invoice.currency),
      tax: money(invoice.taxAmountMinor, invoice.currency),
      total: money(invoice.totalMinor, invoice.currency),
      credits_applied: money(settlement.creditsApplied, invoice.currency),
      paid: money(settlement.paid, invoice.currency),
      written_off: money(settlement.writeOffs, invoice.currency),
      outstanding: money(settlement.outstanding, invoice.currency),
    },
    payment_status: settlement.status,
    payments: [...invoice.paymentEvents]
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
      .map((event) => ({
        id: event.id,
        kind: event.kind.toLowerCase(),
        source: event.source.toLowerCase(),
        amount: money(event.amountMinor, event.currency),
        reference: event.reference,
        occurred_at: event.occurredAt.toISOString(),
        recorded_at: event.createdAt.toISOString(),
      })),
    created_at: invoice.createdAt.toISOString(),
  };
}
