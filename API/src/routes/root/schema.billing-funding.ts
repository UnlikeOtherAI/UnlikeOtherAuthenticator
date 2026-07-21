import type { EndpointSchema } from './schema.js';

const lifecycleAuth =
  'The requested product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion; both remain backend-only';

const fundingSubject = {
  product: 'exact product identifier bound to the app key',
  organisation_id: 'UOA organisation ID',
  team_id: 'UOA team ID',
  user_id: 'UOA user ID',
};

export const billingFundingEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/schemas/billing-credits-v1.json',
    description:
      'Public Draft 2020-12 schema for UOA’s display-ready shared-team credit balance, funding policy, automatic top-up state, and privacy-scoped usage projection.',
    auth: 'public',
    response: { 200: 'BillingCreditsV1 JSON Schema' },
  },
  {
    method: 'GET',
    path: '/schemas/billing-credits-v1.example.json',
    description:
      'Public synthetic BillingCreditsV1 conformance fixture. It contains no production user, tenant, credential, payment, or commercial data.',
    auth: 'public',
    response: { 200: 'Display-ready BillingCreditsV1 example matching the exact JSON Schema' },
  },
  {
    method: 'GET',
    path: '/schemas/billing-credits-v1.openapi.json',
    description:
      'Public OpenAPI 3.1 consumer artifact embedding the exact BillingCreditsV1 JSON Schema and synthetic conformance fixture.',
    auth: 'public',
    response: { 200: 'Versioned OpenAPI 3.1 schema and example document' },
  },
  {
    method: 'GET',
    path: '/schemas/billing-recurring-addons-v1.json',
    description:
      'Public Draft 2020-12 schema for UOA’s display-ready recurring add-on offers and exact-scope subscriptions.',
    auth: 'public',
    response: { 200: 'BillingRecurringAddonsV1 JSON Schema' },
  },
  {
    method: 'GET',
    path: '/schemas/billing-recurring-addons-v1.example.json',
    description:
      'Public synthetic manager/member BillingRecurringAddonsV1 conformance fixtures with no production data.',
    auth: 'public',
    response: {
      200: 'Display-ready BillingRecurringAddonsV1 examples matching the exact JSON Schema',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-recurring-addons-v1.openapi.json',
    description:
      'Public OpenAPI 3.1 consumer artifact embedding the exact recurring-add-on schema and synthetic fixtures.',
    auth: 'public',
    response: { 200: 'Versioned OpenAPI 3.1 schema and example document' },
  },
  {
    method: 'POST',
    path: '/billing/v1/credits',
    description:
      'Settle one exact team-wide Ledger portfolio cursor across every connected service and return the shared Remaining credits projection. Billing managers receive full team attribution and funding metadata; members receive only their own usage plus team-safe aggregates.',
    auth: lifecycleAuth,
    body: fundingSubject,
    response: {
      200: 'BillingCreditsV1 exactly matching /schemas/billing-credits-v1.json',
      '401/403': 'Invalid purpose-bound app key, actor, product, membership, or subject',
      '409': 'The Ledger cursor conflicts with an already-pinned exact-team snapshot',
      '502/503': 'Ledger portfolio evidence or Stripe collection context is unavailable',
    },
    notes:
      'Settlement is deterministic, serializable, and cursor-idempotent. Available credits stop at zero while UOA retains the full centrally rated service/user liability; only a verified reversal may create debt. Products render the returned model and never rate or reallocate credits locally.',
  },
  {
    method: 'POST',
    path: '/billing/v1/credits/top-up-checkout',
    description: 'Create or recover secure Stripe Checkout for one exact active UOA credit offer.',
    auth: lifecycleAuth,
    body: { ...fundingSubject, offer_id: 'exact offer ID from the latest BillingCreditsV1' },
    response: {
      200: '{ redirect_url } for the exact UOA-hosted Checkout',
      '401/403': 'Invalid app key, actor, exact-team manager, or subject',
      409: 'Offer/catalog unavailable or another exact-team Checkout is pending',
      '502/503': 'Stripe binding invalid or reconciliation pending',
    },
    notes:
      'The body is frozen: callers cannot supply an amount, price, currency, quantity, customer, metadata, or return URL. UOA persists immutable intent before Stripe and uses server-derived idempotency.',
  },
  {
    method: 'POST',
    path: '/billing/v1/credits/auto-top-up/setup',
    description:
      'Create or recover Setup Checkout for one exact UOA threshold/refill/monthly-cap option.',
    auth: lifecycleAuth,
    body: { ...fundingSubject, option_id: 'exact option ID from the latest BillingCreditsV1' },
    response: {
      200: '{ redirect_url } for the exact UOA-hosted Setup Checkout',
      '401/403': 'Invalid app key, actor, exact-team manager, or subject',
      409: 'Option/catalog/state unavailable or another setup is pending',
      '502/503': 'Stripe binding invalid or reconciliation pending',
    },
    notes:
      'UOA derives the Stripe customer, price evidence, consent terms, metadata, and allowlisted return URLs. The product relays only the frozen action body.',
  },
  {
    method: 'POST',
    path: '/billing/v1/credits/auto-top-up/update',
    description:
      'Append an immutable manager consent revision selecting one exact active UOA option for the verified saved payment method.',
    auth: lifecycleAuth,
    body: { ...fundingSubject, option_id: 'exact option ID from the latest BillingCreditsV1' },
    response: {
      204: 'Automatic top-up option selected idempotently',
      '401/403': 'Invalid app key, actor, exact-team manager, or subject',
      409: 'Option/catalog, consent state, or payment method unavailable',
      '502/503': 'Stripe binding invalid or unavailable',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/credits/auto-top-up/disable',
    description:
      'Disable future automatic top-ups for the exact team without changing remaining credits.',
    auth: lifecycleAuth,
    body: fundingSubject,
    response: {
      204: 'Automatic top-up disabled idempotently',
      '401/403': 'Invalid app key, actor, exact-team manager, or subject',
      409: 'A payment attempt is still unresolved',
      503: 'Stripe collection context unavailable',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/credits/auto-top-up/recover',
    description:
      'Return the verified HTTPS action URL for an exact unresolved automatic top-up or create bounded replacement Setup Checkout.',
    auth: lifecycleAuth,
    body: fundingSubject,
    response: {
      200: '{ redirect_url } for Stripe-hosted recovery or UOA-created Setup Checkout',
      '401/403': 'Invalid app key, actor, exact-team manager, or subject',
      409: 'No verified recovery is available or the payment is still processing',
      '502/503': 'Stripe metadata/customer/payment binding invalid or unavailable',
    },
    notes:
      'UOA returns only a verified HTTPS URL bound to the exact immutable local attempt; callers cannot select an intent or recovery URL.',
  },
  {
    method: 'POST',
    path: '/billing/v1/recurring-addons',
    description:
      'Return UOA-owned active recurring add-on offers and exact organisation/team/subscribing-user subscription projections for the requested product.',
    auth: lifecycleAuth,
    body: fundingSubject,
    response: {
      200: 'BillingRecurringAddonsV1 exactly matching /schemas/billing-recurring-addons-v1.json',
      '401/403': 'Invalid purpose-bound app key, actor, product, membership, or subject',
      503: 'Stripe collection context is unavailable',
    },
    notes:
      'Billing managers may see subscription identifiers and subscribing-user identity. Members receive relationship-only subscription visibility and no payment or other-user identity details. Mutation actions remain UOA-owned and are exposed only when their verified runtime is available.',
  },
];
