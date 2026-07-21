// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingInvoice } from '../../schemas/billing-contracts';
import { BillingInvoiceDetailDialog } from './BillingInvoiceDetailDialog';

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  issueReset: vi.fn(),
  payment: vi.fn(),
  paymentReset: vi.fn(),
  voidInvoice: vi.fn(),
  voidReset: vi.fn(),
}));

vi.mock('./billing-contract-queries', () => ({
  useIssueBillingInvoiceMutation: () => ({
    error: null,
    isPending: false,
    mutate: mocks.issue,
    reset: mocks.issueReset,
  }),
  useRecordBillingInvoicePaymentMutation: () => ({
    error: null,
    isPending: false,
    mutateAsync: mocks.payment,
    reset: mocks.paymentReset,
  }),
  useVoidBillingInvoiceMutation: () => ({
    error: null,
    isPending: false,
    mutate: mocks.voidInvoice,
    reset: mocks.voidReset,
  }),
}));

function money(amountMinor: string, display: string) {
  return {
    amount_minor: amountMinor,
    amount: String(Number(amountMinor) / 100),
    currency: 'USD',
    display,
  };
}

const zero = money('0', '$0.00');
const total = money('6250', '$62.50');

function invoice(overrides: Partial<BillingInvoice> = {}): BillingInvoice {
  const value: BillingInvoice = {
    id: 'invoice-1',
    organisation_id: 'org-1',
    contract_id: 'contract-1',
    contract_version_id: 'version-1',
    billing_month: '2026-06',
    revision: 1,
    status: 'draft',
    invoice_number: null,
    issue_date: null,
    due_date: null,
    issued_at: null,
    voided_at: null,
    void_reason: null,
    currency: 'USD',
    issuer: {
      profile_id: 'issuer-1',
      legal_name: 'Unlike Other AI Ltd',
      trading_name: null,
      billing_email: 'billing@unlikeotherai.com',
      address: { line1: '1 Example St', city: 'London', postal_code: 'N1 1AA', country: 'GB' },
      tax_identifier: null,
      company_registration_number: null,
    },
    buyer: {
      profile_id: 'buyer-1',
      legal_name: 'Acme Research Ltd',
      billing_email: 'accounts@acme.example',
      billing_address: {
        line1: '2 Customer Rd',
        city: 'Bristol',
        postal_code: 'BS1 1AA',
        country: 'GB',
      },
      tax_identifier: null,
      purchase_order_reference: null,
    },
    lines: [
      {
        id: 'line-1',
        service: { identifier: 'deepwater', name: 'DeepWater' },
        price: total,
      },
    ],
    separately_billed_add_ons: [],
    totals: {
      subtotal: total,
      tax: zero,
      total,
      credits_applied: zero,
      paid: zero,
      written_off: zero,
      outstanding: total,
    },
    payment_status: 'open',
    actions: {
      issue: 'issue',
      download_pdf: false,
      void: false,
      payment_limits: { payment: null, refund: null, write_off: null },
    },
    payments: [],
    created_at: '2026-07-21T00:00:00.000Z',
  };
  return { ...value, ...overrides };
}

describe('BillingInvoiceDetailDialog server-authored actions', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  afterEach(cleanup);

  it('requires confirmation before issuing a ready draft', async () => {
    const user = userEvent.setup();
    render(<BillingInvoiceDetailDialog invoice={invoice()} onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record payment activity' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect(screen.getByText('Issue this legal invoice?')).toBeTruthy();
    expect(mocks.issue).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm issue' }));
    expect(mocks.issue).toHaveBeenCalledWith('invoice-1');
  });

  it('renders the distinct recoverable issuing action supplied by UOA', async () => {
    const user = userEvent.setup();
    render(
      <BillingInvoiceDetailDialog
        invoice={invoice({
          status: 'issuing',
          invoice_number: 'UOA-2026-000001',
          issue_date: '2026-07-21T00:00:00.000Z',
          due_date: '2026-08-20T00:00:00.000Z',
          actions: {
            issue: 'resume_issue',
            download_pdf: false,
            void: false,
            payment_limits: { payment: null, refund: null, write_off: null },
          },
        })}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Resume invoice issue' }));
    expect(screen.getByText('Resume immutable PDF issuance?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
  });

  it('enforces the returned payment cap and does not infer a refund action for a paid invoice', async () => {
    const user = userEvent.setup();
    const issued = invoice({
      status: 'issued',
      invoice_number: 'UOA-2026-000001',
      issue_date: '2026-07-21T00:00:00.000Z',
      due_date: '2026-08-20T00:00:00.000Z',
      issued_at: '2026-07-21T00:00:00.000Z',
      payment_status: 'partially_paid',
      actions: {
        issue: null,
        download_pdf: true,
        void: false,
        payment_limits: { payment: money('5000', '$50.00'), refund: null, write_off: null },
      },
    });
    const { rerender } = render(<BillingInvoiceDetailDialog invoice={issued} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Record payment activity' }));
    expect(screen.getByRole('option', { name: 'Payment' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Refund' })).toBeNull();
    expect(screen.getByText('Maximum $50.00.')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: /^Amount \(minor units\)/ }), '5001');
    await user.click(screen.getByRole('button', { name: 'Record activity' }));
    expect(await screen.findByText('Amount cannot exceed $50.00.')).toBeTruthy();
    expect(mocks.payment).not.toHaveBeenCalled();

    rerender(
      <BillingInvoiceDetailDialog
        invoice={invoice({
          ...issued,
          id: 'invoice-paid',
          payment_status: 'paid',
          totals: { ...issued.totals, paid: total, outstanding: zero },
          actions: {
            issue: null,
            download_pdf: true,
            void: false,
            payment_limits: { payment: null, refund: null, write_off: null },
          },
        })}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Record payment activity' })).toBeNull(),
    );
  });

  it('shows an eligible void control, then renders a void invoice as read-only', async () => {
    const user = userEvent.setup();
    const issued = invoice({
      status: 'issued',
      invoice_number: 'UOA-2026-000001',
      issue_date: '2026-07-21T00:00:00.000Z',
      due_date: '2026-08-20T00:00:00.000Z',
      issued_at: '2026-07-21T00:00:00.000Z',
      actions: {
        issue: null,
        download_pdf: true,
        void: true,
        payment_limits: { payment: null, refund: null, write_off: null },
      },
    });
    const { rerender } = render(<BillingInvoiceDetailDialog invoice={issued} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Void invoice' }));
    expect(screen.getByRole('textbox', { name: 'Reason for voiding' })).toBeTruthy();

    rerender(
      <BillingInvoiceDetailDialog
        invoice={invoice({
          ...issued,
          status: 'void',
          payment_status: 'void',
          voided_at: '2026-07-22T09:30:00.000Z',
          void_reason: 'Customer legal entity changed',
          actions: {
            issue: null,
            download_pdf: true,
            void: false,
            payment_limits: { payment: null, refund: null, write_off: null },
          },
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Customer legal entity changed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume invoice issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record payment activity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void invoice' })).toBeNull();
  });
});
