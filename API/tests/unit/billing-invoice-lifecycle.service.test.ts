import { BillingInvoiceStatus, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  issueBillingInvoice,
  recordBillingInvoicePayment,
  voidBillingInvoice,
} from '../../src/services/billing-invoice-lifecycle.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');

function conflict(code: 'P2002' | 'P2034') {
  return Object.assign(new Error('transaction conflict'), { code });
}

describe('billing invoice lifecycle conflict safety', () => {
  it('stops invoice issuance before its durable claim and PDF effect when admin authority changed', async () => {
    const findUnique = vi.fn();
    const tx = { billingInvoice: { findUnique } };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    } as unknown as PrismaClient;
    const storage = { putImmutable: vi.fn(), read: vi.fn() };

    await expect(
      issueBillingInvoice(
        { invoiceId: 'invoice_1', actor: { userId: 'admin_1', email: 'admin@example.com' } },
        {
          prisma,
          storage,
          now: () => now,
          authorizeAdminEffect: vi.fn().mockRejectedValue(new Error('admin role revoked')),
        },
      ),
    ).rejects.toThrow('admin role revoked');
    expect(findUnique).not.toHaveBeenCalled();
    expect(storage.putImmutable).not.toHaveBeenCalled();
  });

  it('surfaces exhausted issue-claim serialization conflicts as a stable 409', async () => {
    const transaction = vi.fn().mockRejectedValue(conflict('P2034'));
    const prisma = { $transaction: transaction } as unknown as PrismaClient;

    await expect(
      issueBillingInvoice(
        { invoiceId: 'invoice_1', actor: { userId: 'admin_1', email: 'admin@example.com' } },
        { prisma, now: () => now },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_INVOICE_ISSUE_BUSY',
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('keeps a written immutable PDF recoverable when issue finalization stays conflicted', async () => {
    const claimed = {
      id: 'invoice_1',
      orgId: 'org_1',
      status: BillingInvoiceStatus.ISSUING,
      invoiceNumber: 'UOA-2026-000001',
      issueDate: now,
      dueDate: new Date('2026-08-20T00:00:00.000Z'),
      issuerProfile: { active: true, invoiceNumberPrefix: 'UOA' },
      contractVersion: { paymentTermsDays: 30 },
      lines: [],
      addonLines: [],
      paymentEvents: [],
      _count: { creditSettlementRefs: 0 },
    };
    const claimTx = {
      billingInvoice: { findUnique: vi.fn().mockResolvedValue(claimed) },
    };
    const transaction = vi
      .fn()
      .mockImplementationOnce(async (operation: (tx: typeof claimTx) => unknown) =>
        operation(claimTx),
      )
      .mockRejectedValue(conflict('P2034'));
    const storage = {
      putImmutable: vi.fn().mockResolvedValue(undefined),
      read: vi.fn(),
    };

    await expect(
      issueBillingInvoice(
        { invoiceId: 'invoice_1', actor: { userId: 'admin_1', email: 'admin@example.com' } },
        {
          prisma: { $transaction: transaction } as unknown as PrismaClient,
          storage,
          now: () => now,
          generatePdf: vi.fn().mockResolvedValue(Uint8Array.from([37, 80, 68, 70])),
          authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_INVOICE_ISSUE_BUSY',
    });
    expect(transaction).toHaveBeenCalledTimes(4);
    expect(storage.putImmutable).toHaveBeenCalledOnce();
    expect(storage.putImmutable).toHaveBeenCalledWith(
      'billing-invoices/org_1/invoice_1.pdf',
      Uint8Array.from([37, 80, 68, 70]),
    );
  });

  it('retries payment uniqueness conflicts and returns a stable 409 when exhausted', async () => {
    const transaction = vi.fn().mockRejectedValue(conflict('P2002'));
    const prisma = { $transaction: transaction } as unknown as PrismaClient;

    await expect(
      recordBillingInvoicePayment(
        {
          invoiceId: 'invoice_1',
          kind: 'payment',
          amountMinor: '5000',
          currency: 'USD',
          idempotencyKey: 'payment-1',
          occurredAt: now,
          actor: { userId: 'admin_1', email: 'admin@example.com' },
        },
        { prisma, now: () => now },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_INVOICE_PAYMENT_BUSY',
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('forbids voiding an invoice settled with prepaid credits', async () => {
    const update = vi.fn();
    const tx = {
      billingInvoice: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'invoice_1',
          status: BillingInvoiceStatus.ISSUED,
          creditsAppliedMinor: 0n,
          paymentEvents: [],
          _count: { creditSettlementRefs: 1 },
        }),
        update,
      },
    };
    const transaction = vi
      .fn()
      .mockImplementation(async (operation: (client: typeof tx) => unknown) => operation(tx));

    await expect(
      voidBillingInvoice(
        {
          invoiceId: 'invoice_1',
          reason: 'Incorrect billing period',
          actor: { userId: 'admin_1', email: 'admin@example.com' },
        },
        {
          prisma: { $transaction: transaction } as unknown as PrismaClient,
          now: () => now,
          authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_INVOICE_VOID_FORBIDDEN',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
