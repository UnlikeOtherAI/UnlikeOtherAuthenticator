import type { EndpointSchema } from './schema.js';

const runtime = 'Product BROWSER_RUNTIME app key; server only';
const subject = {
  product: 'Registered product',
  organisation_id: 'Exact UOA organisation',
  team_id: 'Exact selected UOA team',
  user_id: 'Original human subject',
  project_id: 'Browserbase project UUID',
};
const dispatch = { product: 'Registered product', dispatch_id: 'Stable physical browser UUID' };
const reservation = {
  200: 'Immutable reservation identity, state, one-shot can_dispatch, held/consumed credits and claim deadline',
  409: 'Binding conflict, exhausted funds/budget, stale dispatch or conflicting receipt',
};
const adminPath = '/internal/admin/billing/services/:serviceId/browser-policies';
export const billingBrowserEndpoints: EndpointSchema[] = [
  {
    method: 'POST',
    path: '/billing/v1/browser/tariff',
    auth: `${runtime}; fresh exact-endpoint X-UOA-Actor`,
    description:
      'Read the current provider-project browser tariff. This does not reserve spending authority.',
    body: subject,
    response: {
      200: 'USD provider hourly cost, customer minute price, fixed 10% markup, one-minute minimum and rounding, expiry',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/browser/reservations',
    auth: `${runtime}; fresh exact-endpoint X-UOA-Actor`,
    description: 'Reserve live prepaid credits and run budget for one browser before provider creation.',
    body: {
      ...subject,
      dispatch_id: 'UUID',
      max_duration_seconds: 'Integer 60–1800',
      budget_context:
        'Original run and budget-root IDs, timestamps and subjects, or null for direct human use',
    },
    response: reservation,
  },
  ...(['read', 'claim'] as const).map((action) => ({
    method: 'POST',
    path: `/billing/v1/browser/reservations/${action}`,
    auth: runtime,
    description:
      action === 'claim'
        ? 'Claim one dispatch exactly once with current captured subject authority.'
        : 'Read the original product-bound reservation for runtime recovery.',
    body: dispatch,
    response: reservation,
  })),
  {
    method: 'POST',
    path: '/billing/v1/browser/reservations/receipt',
    auth: runtime,
    description: 'Settle exact provider terminal evidence once, including after human revocation.',
    body: {
      ...dispatch,
      project_id: 'Bound Browserbase project UUID',
      session_id: 'Original provider session UUID',
      status: 'COMPLETED | ERROR | TIMED_OUT',
      started_at: 'Provider ISO timestamp',
      ended_at: 'Provider ISO timestamp',
      proxy_bytes: 'Nonnegative safe integer; unexpected traffic retains the hold for reconciliation',
    },
    response: reservation,
  },
  {
    method: 'POST',
    path: '/billing/v1/browser/reservations/release',
    auth: runtime,
    description:
      'Release only with durable proof that no provider session was created; missing dispatches get a cancellation tombstone.',
    body: {
      ...dispatch,
      proof: 'no_provider_dispatch | provider_rejected',
      provider_http_status: 'Required only for provider_rejected: 400 | 401 | 403 | 404 | 422 | 429',
    },
    response: {
      200: 'dispatch_id and released:true',
      409: 'Provider dispatch or evidence prevents cancellation',
    },
  },
  {
    method: 'GET',
    path: adminPath,
    auth: 'Current admin-domain platform SUPERUSER',
    description:
      'List immutable browser tariff versions and pending/reconciliation counts for the selected product.',
    response: { 200: 'policies, pending, reconciliation; private/no-store' },
  },
  {
    method: 'POST',
    path: adminPath,
    auth: 'Current admin-domain platform SUPERUSER, rechecked under transaction locks',
    description:
      'Publish a new tariff version for one provider project; existing reservations keep their price.',
    body: {
      project_id: 'Browserbase project UUID',
      provider_price_per_hour: 'Positive exact USD decimal string',
      rounding_seconds: '60',
      source_url: 'HTTPS Browserbase price evidence URL',
      valid_until: 'ISO timestamp, within 90 days',
      expected_policy_id: 'Current version ID or null; optimistic concurrency check',
    },
    response: { 201: 'Published tariff', 409: 'Another operator changed the current version' },
  },
];
