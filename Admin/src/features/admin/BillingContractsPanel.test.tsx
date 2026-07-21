// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingService } from '../../schemas/billing';
import { BillingContractsPanel } from './BillingContractsPanel';

const state = vi.hoisted(() => {
  const money = (amountMinor: string, display: string) => ({
    amount_minor: amountMinor,
    amount: String(Number(amountMinor) / 100),
    currency: 'USD',
    display,
  });
  const version = {
    id: 'version-1',
    version: 1,
    usage_markup_bps: 4000,
    usage_markup_percent: '40.00',
    currency: 'USD',
    payment_terms_days: 30,
    effective_from_month: '2026-06',
    services: [
      {
        service_id: 'service-1',
        service_identifier: 'deepwater',
        service_name: 'DeepWater',
        tariff_id: 'tariff-1',
        monthly_amount_minor: '5000',
        monthly_price: money('5000', '$50.00'),
      },
    ],
    actions: { activation_state: 'active' as const, activate: false },
    created_at: '2026-06-01T00:00:00.000Z',
  };
  const draftVersion = {
    ...version,
    id: 'version-2',
    version: 2,
    usage_markup_bps: 4500,
    usage_markup_percent: '45.00',
    effective_from_month: '2026-07',
    services: [],
    actions: { activation_state: 'ready' as const, activate: true },
    created_at: '2026-07-20T00:00:00.000Z',
  };
  const contract = {
    id: 'contract-1',
    organisation_id: 'org-1',
    organisation_name: 'Acme Research',
    reference: 'MSA-2026-001',
    name: 'Enterprise AI services',
    status: 'active' as const,
    activated_at: '2026-07-01T00:00:00.000Z',
    terminated_at: null,
    versions: [version, draftVersion],
    actions: { add_version: true },
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
  };
  const issuer = {
    id: 'issuer-1',
    key: 'uoa-uk',
    legal_name: 'Unlike Other AI Ltd',
    trading_name: null,
    billing_email: 'billing@unlikeotherai.com',
    address: {
      line1: '1 Example Street',
      city: 'London',
      postal_code: 'N1 1AA',
      country: 'GB',
    },
    tax_identifier: null,
    company_registration_number: null,
    invoice_number_prefix: 'UOA',
    active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
  const invoice = {
    id: 'invoice-1',
    organisation_id: 'org-1',
    contract_id: 'contract-1',
    contract_version_id: 'version-1',
    billing_month: '2026-07',
    revision: 1,
    status: 'issued' as const,
    invoice_number: 'UOA-2026-000001',
    issue_date: '2026-07-21T00:00:00.000Z',
    due_date: '2026-08-20T00:00:00.000Z',
    issued_at: '2026-07-21T00:00:00.000Z',
    voided_at: null,
    void_reason: null,
    currency: 'USD',
    issuer: {
      profile_id: issuer.id,
      legal_name: issuer.legal_name,
      trading_name: null,
      billing_email: issuer.billing_email,
      address: issuer.address,
      tax_identifier: null,
      company_registration_number: null,
    },
    buyer: {
      profile_id: 'buyer-1',
      legal_name: 'Acme Research Ltd',
      billing_email: 'accounts@acme.example',
      billing_address: {
        line1: '2 Customer Road',
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
        price: money('12500', '$125.00'),
      },
      {
        id: 'line-2',
        service: { identifier: 'nessie', name: 'Nessie' },
        price: money('2500', '$25.00'),
      },
    ],
    separately_billed_add_ons: [],
    totals: {
      subtotal: money('15000', '$150.00'),
      tax: money('0', '$0.00'),
      total: money('15000', '$150.00'),
      credits_applied: money('0', '$0.00'),
      paid: money('15000', '$150.00'),
      written_off: money('0', '$0.00'),
      outstanding: money('0', '$0.00'),
    },
    payment_status: 'paid' as const,
    actions: {
      issue: null,
      download_pdf: true,
      void: false,
      payment_limits: {
        payment: null,
        refund: money('15000', '$150.00'),
        write_off: null,
      },
    },
    payments: [
      {
        id: 'payment-1',
        kind: 'payment' as const,
        source: 'manual' as const,
        amount: money('15000', '$150.00'),
        reference: 'BANK-100',
        occurred_at: '2026-07-21T10:00:00.000Z',
        recorded_at: '2026-07-21T10:01:00.000Z',
      },
    ],
    created_at: '2026-07-21T00:00:00.000Z',
    raw_provider_cost: '$42.11 raw provider cost',
    raw_token_count: '987,654 tokens',
  };
  return {
    calculate: vi.fn(),
    calculateReset: vi.fn(),
    issue: vi.fn(),
    issueReset: vi.fn(),
    invoice,
    issuer,
    contract,
    voidInvoice: vi.fn(),
    voidReset: vi.fn(),
    recordPayment: vi.fn(),
    paymentReset: vi.fn(),
  };
});

function mutation(mutateAsync: ReturnType<typeof vi.fn>, reset: ReturnType<typeof vi.fn>) {
  return {
    error: null,
    isError: false,
    isPending: false,
    mutate: mutateAsync,
    mutateAsync,
    reset,
  };
}

vi.mock('./admin-queries', () => ({
  useOrganisationsQuery: () => ({ data: [{ id: 'org-1', name: 'Acme Research' }] }),
}));

vi.mock('./billing-contract-queries', () => ({
  useBillingContractsQuery: () => ({ data: [state.contract], isError: false, isLoading: false }),
  useBillingInvoiceIssuersQuery: () => ({ data: [state.issuer], isError: false, isLoading: false }),
  useBillingInvoicesQuery: () => ({ data: [state.invoice], isError: false, isLoading: false }),
  useCalculateBillingInvoiceMutation: () => mutation(state.calculate, state.calculateReset),
  useIssueBillingInvoiceMutation: () => mutation(state.issue, state.issueReset),
  useVoidBillingInvoiceMutation: () => mutation(state.voidInvoice, state.voidReset),
  useRecordBillingInvoicePaymentMutation: () => mutation(state.recordPayment, state.paymentReset),
  useCreateBillingContractMutation: () => mutation(vi.fn(), vi.fn()),
  useCreateBillingContractVersionMutation: () => mutation(vi.fn(), vi.fn()),
  useActivateBillingContractVersionMutation: () => mutation(vi.fn(), vi.fn()),
  useCreateBillingInvoiceIssuerMutation: () => mutation(vi.fn(), vi.fn()),
  useSaveBillingInvoiceBuyerMutation: () => mutation(vi.fn(), vi.fn()),
  useBillingInvoiceBuyerQuery: () => ({
    data: undefined,
    fetchStatus: 'idle',
    isError: false,
    isPending: false,
  }),
}));

vi.mock('./BillingContractDialogs', () => ({
  CreateBillingContractDialog: () => null,
  AddBillingContractVersionDialog: () => null,
  ActivateBillingContractVersionDialog: () => null,
}));

vi.mock('./BillingInvoiceProfileDialogs', () => ({
  CreateBillingInvoiceIssuerDialog: () => null,
  EditBillingInvoiceBuyerDialog: () => null,
}));

const services = [
  {
    id: 'service-1',
    identifier: 'deepwater',
    name: 'DeepWater',
    active: true,
    tariffs: [],
    assignments: [],
    app_keys: [],
    adjustments: [],
    stripe_catalogs: [],
    stripe_subscriptions: [],
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  },
] satisfies BillingService[];

describe('BillingContractsPanel', () => {
  beforeEach(() => {
    state.calculate.mockReset().mockResolvedValue(state.invoice);
    state.calculateReset.mockReset();
    state.issue.mockReset();
    state.issueReset.mockReset();
    state.voidInvoice.mockReset();
    state.voidReset.mockReset();
    state.recordPayment.mockReset();
    state.paymentReset.mockReset();
  });

  afterEach(cleanup);

  it('shows contract terms, invoice totals, and lifecycle affordances without private usage data', async () => {
    const user = userEvent.setup();
    render(<BillingContractsPanel services={services} />);

    expect(screen.getByRole('heading', { name: 'Organisation contracts' })).toBeTruthy();
    expect(screen.getByText('Enterprise AI services')).toBeTruthy();
    expect(screen.getByText('40.00%')).toBeTruthy();
    expect(screen.getByText('45.00%')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Activate' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Calculate draft' })).toBeTruthy();
    expect(screen.getAllByText('UOA-2026-000001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);

    expect(screen.queryByRole('columnheader', { name: /token count/i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /raw.*cost/i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /internal margin/i })).toBeNull();
    expect(screen.queryByText('$42.11 raw provider cost')).toBeNull();
    expect(screen.queryByText('987,654 tokens')).toBeNull();

    await user.click(screen.getAllByRole('button', { name: 'View' })[0]);
    const detail = screen.getByRole('dialog', { name: 'UOA-2026-000001' });
    expect(within(detail).getByRole('columnheader', { name: 'Calculated price' })).toBeTruthy();
    expect(within(detail).getAllByText('DeepWater').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText('$125.00').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText('Invoice total').length).toBeGreaterThan(0);
    expect(within(detail).getByRole('button', { name: 'Download PDF' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Record payment activity' })).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Void invoice' })).toBeNull();
    expect(within(detail).getByText('Payment activity')).toBeTruthy();
    expect(within(detail).getByText('BANK-100', { exact: false })).toBeTruthy();
  });

  it('submits the selected frozen inputs and opens the calculated customer-safe draft', async () => {
    const user = userEvent.setup();
    const now = new Date();
    const closedMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    render(<BillingContractsPanel services={services} />);

    await waitFor(() => {
      expect(
        (screen.getByRole('combobox', { name: 'Active contract' }) as HTMLSelectElement).value,
      ).toBe('contract-1');
      expect((screen.getByRole('combobox', { name: 'Issuer' }) as HTMLSelectElement).value).toBe(
        'issuer-1',
      );
    });
    expect((screen.getByLabelText('Billing month') as HTMLInputElement).value).toBe(closedMonth);
    await user.click(screen.getByRole('button', { name: 'Calculate draft' }));

    await waitFor(() =>
      expect(state.calculate).toHaveBeenCalledWith({
        contractId: 'contract-1',
        issuerProfileId: 'issuer-1',
        billingMonth: closedMonth,
      }),
    );
    const detail = await screen.findByRole('dialog', { name: 'UOA-2026-000001' });
    expect(within(detail).getAllByText('$125.00').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText('$150.00').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText('$0.00').length).toBeGreaterThan(0);
  });
});
