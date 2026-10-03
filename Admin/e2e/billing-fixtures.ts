/** Synthetic billing responses; no production account or payment provider is contacted. */
export function createBillingFixtures() {
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
        service_id: 'billing-1',
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
    organisation_id: 'o1',
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
    organisation_id: 'o1',
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

  const contracts = [
    contract,
    { ...contract, id: 'contract-2', name: 'Second contract', reference: 'MSA-SECOND' },
  ];
  return { contracts, issuer, invoice };
}
