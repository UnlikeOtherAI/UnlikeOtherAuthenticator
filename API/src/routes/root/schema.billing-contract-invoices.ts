import type { EndpointSchema } from './schema.js';

const adminAuth =
  'Authorization: Bearer <access_token>; token must be an ADMIN_AUTH_DOMAIN platform superuser and remain backed by a SUPERUSER domain_roles row';

export const billingContractInvoiceEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/internal/admin/billing/contracts',
    description:
      'List organisation contracts and immutable versions. This contract-editor response may show the organisation-wide usage markup; invoice responses never do.',
    auth: adminAuth,
    query: { organisation_id: 'optional exact UOA organisation ID' },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/contracts',
    description: 'Create an inactive organisation contract header.',
    auth: adminAuth,
    body: {
      organisation_id: 'exact UOA organisation ID',
      reference: 'stable lowercase operator reference',
      name: 'operator-facing contract name',
    },
    response: { 201: 'Created draft contract' },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/contracts/:contractId/versions',
    description:
      'Append an immutable forward-effective commercial version. Markup is visible only on this contract-editor surface.',
    auth: adminAuth,
    body: {
      usage_markup_bps: 'integer 0-100000 applied centrally to provider cost',
      currency: 'exact three-letter ISO currency; no FX inference',
      payment_terms_days: 'integer 0-365',
      effective_from_month: 'UTC YYYY-MM, later than every existing version',
    },
    response: { 201: 'Created immutable version without active service terms' },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/contracts/:contractId/versions/:versionId/activate',
    description:
      'On or after its effective UTC month, atomically activate the version and project one immutable CUSTOM+MANUAL org tariff per selected service. Rejects carried-assignment drift, team overrides, and nonterminal Stripe state.',
    auth: adminAuth,
    body: {
      services:
        'non-empty [{ service_id, monthly_amount_minor }]; service set is pinned to the version',
    },
    response: { 200: 'Activated contract version with service terms' },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoice-issuer-profiles',
    description: 'List explicit legal issuer profiles. UOA never invents or seeds issuer identity.',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/invoice-issuer-profiles',
    description: 'Create an explicit legal issuer and invoice-number prefix.',
    auth: adminAuth,
    body: {
      key: 'stable profile key',
      legal_name: 'required legal name',
      billing_email: 'required invoice email',
      address: '{ line1, line2?, city, region?, postal_code, country }',
      invoice_number_prefix: 'uppercase letters/numbers/_/-',
      optional: 'trading_name, tax_identifier, company_registration_number; tax is never inferred',
    },
    response: { 201: 'Created issuer profile' },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/organisations/:organisationId/invoice-profile',
    description: 'Read the organisation buyer legal/billing profile used for invoice snapshots.',
    auth: adminAuth,
  },
  {
    method: 'PUT',
    path: '/internal/admin/billing/organisations/:organisationId/invoice-profile',
    description:
      'Create or update the explicit buyer profile; issued invoices retain their snapshot.',
    auth: adminAuth,
    body: {
      legal_name: 'required buyer legal name',
      billing_email: 'required accounts-payable email',
      billing_address: '{ line1, line2?, city, region?, postal_code, country }',
      optional: 'tax_identifier, purchase_order_reference',
    },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/invoices/calculate',
    description:
      'Calculate a closed-month organisation invoice from one immutable org-scoped Ledger snapshot per contracted service. The response contains gross final price per service plus a separately labelled credits settlement; changed input creates the next immutable revision.',
    auth: adminAuth,
    body: {
      contract_id: 'active organisation contract ID',
      issuer_profile_id: 'active explicit issuer profile ID',
      billing_month: 'closed UTC YYYY-MM',
    },
    response: {
      201: 'Customer-safe draft invoice; never markup, cost, units, calls, cursor/hash, or digest',
    },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoices',
    description:
      'List customer-safe contract invoice revisions with final per-service prices, separate credit/payment/write-off settlement totals, and payment status.',
    auth: adminAuth,
    query: {
      organisation_id: 'optional',
      contract_id: 'optional',
      billing_month: 'optional UTC YYYY-MM',
      status: 'optional draft | issuing | issued | void',
    },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoices/:invoiceId',
    description:
      'Read one customer-safe invoice. Private Ledger references and internal calculation inputs are never serialized.',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/invoices/:invoiceId/issue',
    description:
      'Idempotently allocate a serial invoice number, generate/store a wrapping-safe Unicode private immutable PDF, and issue the exact frozen draft revision.',
    auth: adminAuth,
    body: {},
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoices/:invoiceId/pdf',
    description:
      'Stream an issued/void immutable PDF after SHA-256 verification. Response is private, no-store and final-price-only.',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/invoices/:invoiceId/void',
    description:
      'Void an unpaid issued invoice without deleting or reusing its number/PDF. Settled invoices cannot be voided.',
    auth: adminAuth,
    body: { reason: 'required audit reason, max 500' },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/invoices/:invoiceId/payments',
    description:
      'Append an idempotent manual payment, refund, or write-off event without changing service prices.',
    auth: adminAuth,
    body: {
      kind: 'payment | refund | write_off',
      amount_minor: 'positive integer string in invoice currency',
      currency: 'exact invoice currency',
      idempotency_key: 'required stable key',
      reference: 'optional external reference',
      occurred_at: 'ISO timestamp',
    },
    response: { 201: 'Customer-safe invoice with updated separate settlement totals' },
  },
];
