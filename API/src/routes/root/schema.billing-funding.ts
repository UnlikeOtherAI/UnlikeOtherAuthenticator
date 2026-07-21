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
