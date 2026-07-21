import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { billingInvoicePdfStorageConfigured } from './billing-invoice-storage.service.js';

export type BillingInvoiceIssueAction = 'issue' | 'resume_issue' | null;

export type BillingInvoiceIssueCandidate = {
  id: string;
  status: BillingInvoiceStatus;
  invoiceNumber: string | null;
  issueDate: Date | null;
  dueDate: Date | null;
};

type BillingInvoiceActionReadinessDeps = {
  prisma?: PrismaClient;
  storageConfigured?: boolean;
};

export async function resolveBillingInvoiceIssueActions(
  invoices: readonly BillingInvoiceIssueCandidate[],
  deps?: BillingInvoiceActionReadinessDeps,
): Promise<Map<string, BillingInvoiceIssueAction>> {
  const actions = new Map<string, BillingInvoiceIssueAction>();
  for (const invoice of invoices) actions.set(invoice.id, null);

  if (!(deps?.storageConfigured ?? billingInvoicePdfStorageConfigured())) return actions;

  const draftIds = [
    ...new Set(
      invoices
        .filter((invoice) => invoice.status === BillingInvoiceStatus.DRAFT)
        .map((invoice) => invoice.id),
    ),
  ];
  if (draftIds.length > 0) {
    const prisma = deps?.prisma ?? getAdminPrisma();
    const rows = await prisma.$queryRaw<Array<{ invoiceId: string; ready: boolean }>>(Prisma.sql`
      SELECT requested."invoice_id" AS "invoiceId",
        uoa_billing_invoice_issue_ready(requested."invoice_id") AS "ready"
      FROM unnest(ARRAY[${Prisma.join(draftIds)}]::text[]) AS requested("invoice_id")
    `);
    for (const row of rows) {
      if (row.ready && actions.has(row.invoiceId)) actions.set(row.invoiceId, 'issue');
    }
  }

  for (const invoice of invoices) {
    if (
      invoice.status === BillingInvoiceStatus.ISSUING &&
      invoice.invoiceNumber !== null &&
      invoice.issueDate !== null &&
      invoice.dueDate !== null
    ) {
      actions.set(invoice.id, 'resume_issue');
    }
  }
  return actions;
}
