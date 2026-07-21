import { BillingInvoiceStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveBillingInvoiceIssueActions,
  type BillingInvoiceIssueCandidate,
} from '../../src/services/billing-invoice-action-readiness.service.js';

function candidate(
  id: string,
  status: BillingInvoiceStatus,
  values?: Partial<BillingInvoiceIssueCandidate>,
): BillingInvoiceIssueCandidate {
  return {
    id,
    status,
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    ...values,
  };
}

describe('billing invoice issue action readiness', () => {
  it('bulk resolves draft readiness through the canonical database function', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { invoiceId: 'invoice_ready', ready: true },
      { invoiceId: 'invoice_blocked', ready: false },
    ]);

    const actions = await resolveBillingInvoiceIssueActions(
      [
        candidate('invoice_ready', BillingInvoiceStatus.DRAFT),
        candidate('invoice_blocked', BillingInvoiceStatus.DRAFT),
        candidate('invoice_issued', BillingInvoiceStatus.ISSUED),
      ],
      { prisma: { $queryRaw: queryRaw } as never, storageConfigured: true },
    );

    expect(actions).toEqual(
      new Map([
        ['invoice_ready', 'issue'],
        ['invoice_blocked', null],
        ['invoice_issued', null],
      ]),
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]?.[0]?.strings?.join(' ')).toContain(
      'uoa_billing_invoice_issue_ready',
    );
  });

  it('fails every action closed when immutable PDF storage is not configured', async () => {
    const queryRaw = vi.fn();
    const actions = await resolveBillingInvoiceIssueActions(
      [
        candidate('invoice_draft', BillingInvoiceStatus.DRAFT),
        candidate('invoice_issuing', BillingInvoiceStatus.ISSUING, {
          invoiceNumber: 'UOA-2026-000001',
          issueDate: new Date('2026-07-21T00:00:00.000Z'),
          dueDate: new Date('2026-08-20T00:00:00.000Z'),
        }),
      ],
      { prisma: { $queryRaw: queryRaw } as never, storageConfigured: false },
    );

    expect(actions).toEqual(
      new Map([
        ['invoice_draft', null],
        ['invoice_issuing', null],
      ]),
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('resumes only an issuing invoice with its complete immutable identity', async () => {
    const complete = {
      invoiceNumber: 'UOA-2026-000001',
      issueDate: new Date('2026-07-21T00:00:00.000Z'),
      dueDate: new Date('2026-08-20T00:00:00.000Z'),
    };
    const actions = await resolveBillingInvoiceIssueActions(
      [
        candidate('invoice_complete', BillingInvoiceStatus.ISSUING, complete),
        candidate('invoice_no_number', BillingInvoiceStatus.ISSUING, {
          ...complete,
          invoiceNumber: null,
        }),
        candidate('invoice_no_issue_date', BillingInvoiceStatus.ISSUING, {
          ...complete,
          issueDate: null,
        }),
        candidate('invoice_no_due_date', BillingInvoiceStatus.ISSUING, {
          ...complete,
          dueDate: null,
        }),
      ],
      { storageConfigured: true },
    );

    expect(actions.get('invoice_complete')).toBe('resume_issue');
    expect(actions.get('invoice_no_number')).toBeNull();
    expect(actions.get('invoice_no_issue_date')).toBeNull();
    expect(actions.get('invoice_no_due_date')).toBeNull();
  });
});
