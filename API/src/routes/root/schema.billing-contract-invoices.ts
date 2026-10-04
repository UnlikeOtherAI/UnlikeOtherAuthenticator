import type { EndpointSchema } from './schema.js';

const adminAuth =
  'Authorization: Bearer <access_token>; token must be an ADMIN_AUTH_DOMAIN platform superuser and remain backed by a SUPERUSER domain_roles row';

const contractActionProjection =
  'Server-authored contract.actions.add_version; clients render it and never reconstruct eligibility.';
const versionActionProjection =
  'Server-authored version.actions.{activation_state,activate}. ready is a future-month draft eligible for activation; scheduled is an activated future-month version. Other states are active | superseded | contract_terminated. Clients render these values and never reconstruct eligibility.';
const contractAndVersionActionProjection =
  contractActionProjection + ' Nested versions use ' + versionActionProjection;
const invoiceActionProjection =
  'Server-authored actions: issue is issue only after the database proves active contract/issuer, exact frozen evidence, collector exclusivity, and active-invoice uniqueness; it is resume_issue for recoverable issuance, otherwise null. download_pdf and void are booleans; any private positive credit-settlement reference blocks void even when its display rounds to zero. payment_limits contains nullable payment/refund/write_off maximum Money values. Clients render these values and never reconstruct lifecycle eligibility or payment caps. The private PDF object key and SHA-256 are never serialized.';

export const billingContractInvoiceEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/internal/admin/billing/contracts',
    description:
      'List organisation contracts and immutable versions. This contract-editor response may show the organisation-wide usage markup; invoice responses never do. ' +
      contractAndVersionActionProjection,
    auth: adminAuth,
    query: { organisation_id: 'optional exact UOA organisation ID' },
    response: { 200: 'Contract array. ' + contractAndVersionActionProjection },
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
    response: { 201: 'Created draft contract. ' + contractActionProjection },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/contracts/:contractId/versions',
    description:
      'Append an immutable forward-effective commercial version. Markup is visible only on this contract-editor surface.',
    auth: adminAuth,
    body: {
      usage_markup_percent:
        'exact decimal percentage string with at most two fractional digits, applied centrally',
      currency: 'exact three-letter ISO currency; no FX inference',
      payment_terms_days: 'integer 0-365',
      effective_from_month: 'UTC YYYY-MM, later than every existing version',
    },
    response: {
      201: 'Created immutable version without active service terms. ' + versionActionProjection,
    },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/contracts/:contractId/versions/:versionId/activate',
    description:
      'Schedule future-effective immutable CUSTOM+MANUAL organisation terms per selected service. Capture the UOA seat baseline now and track it until the commercial month. Reject carried-assignment drift, team overrides, and nonterminal Stripe state.',
    auth: adminAuth,
    body: {
      services:
        'non-empty [{ service_id, monthly_amount_minor, monthly_charge_basis?, seat_policy?, seat_charge_timing?, usage_payment_mode?, fixed_seat_quantity? }]. New operator writes choose the basis and usage mode; fixed quantity is required only for fixed per-seat terms. Omitted fields retain legacy flat/pay-as-you-go semantics.',
    },
    response: { 200: 'Activated contract version with service terms. ' + versionActionProjection },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoice-issuer-profiles',
    description: 'List explicit legal issuer profiles. UOA never invents or seeds issuer identity.',
    auth: adminAuth,
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/credit-invoice-tax-policies',
    description: 'List Stripe accounts and append-only legal issuer tax policies for accepted prepaid payment invoices. Platform superuser only.',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/credit-invoice-tax-policies',
    description: 'Append a versioned issuer tax treatment effective at a UTC payment time. The tax amount is included within the actual accepted gross; this action never charges the payer.',
    auth: adminAuth,
    body: {
      account_id: 'exact Stripe account row ID',
      issuer_profile_id: 'active explicit issuer with the same tax jurisdiction',
      jurisdiction_country: 'two-letter uppercase issuer jurisdiction',
      treatment: 'INCLUSIVE_RATE or NO_TAX_CHARGED',
      rate_bps: 'integer inclusive tax rate 1-10000, or 0 for explicit no-tax treatment',
      legal_basis_reference: 'operator-attested legal rule or exemption reference',
      effective_from: 'UTC ISO timestamp, exact effective start',
    },
    response: { 201: 'Created immutable policy version and actor audit event' },
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
      tax_treatment: 'no_tax_charged | standard_rate',
      tax_rate_percent: 'exact 0..100 with at most two fractional digits',
      tax_legal_basis: 'required legal basis frozen with the invoice',
    },
    response: {
      201:
        'Customer-safe draft invoice; never markup, cost, units, calls, cursor/hash, digest, or private PDF storage identity. ' +
        invoiceActionProjection,
    },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/cycle-corrections',
    description: 'List closed-month manual billing cycle corrections awaiting a real legal financial effect.',
    auth: adminAuth,
    response: { 200: 'Pending correction cycles with direction and optional supplement invoice id.' },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/cycle-corrections/:cycleId/prepare',
    description: 'Freeze a delta-only supplemental invoice from signed paid receipts, the original issued line and its tax evidence. No original monthly fee is repeated.',
    auth: adminAuth,
    body: {},
    response: { 201: 'Customer-safe draft supplemental invoice ready for ordinary issue.' },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoices',
    description:
      'List customer-safe contract invoice revisions with final per-service prices, separate credit/payment/write-off settlement totals, and payment status. ' +
      invoiceActionProjection,
    auth: adminAuth,
    query: {
      organisation_id: 'optional',
      contract_id: 'optional',
      billing_month: 'optional UTC YYYY-MM',
      status: 'optional draft | issuing | issued | void',
    },
    response: { 200: 'Customer-safe invoice array. ' + invoiceActionProjection },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/invoices/:invoiceId',
    description:
      'Read one customer-safe invoice. Private Ledger references, internal calculation inputs, and private PDF storage identity are never serialized. ' +
      invoiceActionProjection,
    auth: adminAuth,
    response: { 200: 'Customer-safe invoice. ' + invoiceActionProjection },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/invoices/:invoiceId/issue',
    description:
      'Idempotently allocate a serial invoice number, generate/store a wrapping-safe Unicode private immutable PDF, and issue the exact frozen draft revision.',
    auth: adminAuth,
    body: {},
    response: {
      200: 'Customer-safe issued or recoverable issuing invoice. ' + invoiceActionProjection,
    },
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
    response: { 200: 'Customer-safe void invoice. ' + invoiceActionProjection },
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
    response: {
      201:
        'Customer-safe invoice with updated separate settlement totals. ' + invoiceActionProjection,
    },
  },
];
