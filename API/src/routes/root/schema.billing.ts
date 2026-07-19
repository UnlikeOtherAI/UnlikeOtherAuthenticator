import type { EndpointSchema } from './schema.js';

const adminAuth =
  'Authorization: Bearer <access_token>; token must be an ADMIN_AUTH_DOMAIN platform superuser and remain backed by a SUPERUSER domain_roles row';
const tariffBody = {
  key: 'string (required, stable tariff family key)',
  name: 'string (required, max 120)',
  mode: 'standard | free | at_cost | custom',
  collection_mode:
    'stripe | manual | none; free requires none; none preserves rating/visibility without collecting payment',
  markup_bps: 'integer 0-100000; 100 basis points = 1%; must be 0 for free and at_cost',
  monthly_subscription:
    '{ amount_minor: non-negative integer string, currency: three-letter uppercase ISO currency }',
};

export const billingEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/billing/v1/jwks.json',
    description:
      'Public JWKS for content-free effective-tariff snapshots. It publishes the current and overlapping retired public keys, and returns 404 until both tariff snapshot key variables are configured.',
    auth: 'public',
    response: {
      200: '{ keys: [current and overlapping retired public RS256 JWKs] }',
      404: 'Tariff snapshot signing is not configured',
    },
  },
  {
    method: 'GET',
    path: '/billing/v1/service-jwks.json',
    description:
      'Public JWKS used only to verify UOA’s short-lived Ledger billing-collector service assertions. It contains the current and overlapping retired public keys and is separate from tariff-snapshot, OAuth-resource-token, product-app-key, and webhook credentials.',
    auth: 'public',
    response: {
      200: '{ keys: [current and overlapping retired public RS256 JWKs] }',
      404: 'Ledger billing assertion signing is not configured',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/effective-tariff',
    description:
      'Resolve team > organisation > service-default tariff precedence, re-check active UOA membership, and return a signed content-free snapshot. Raw metered quantities remain immutable; the signed multiplier rates money and separately labeled customer billable units.',
    auth: 'X-UOA-App-Key: uoa_app_… credential dedicated to the requested product, plus X-UOA-Actor: short-lived RS256 actor JWT bound to that credential',
    body: {
      product: 'string (required) — exact global billing service identifier bound to the app key',
      organisation_id: 'string (required)',
      team_id: 'string (required)',
      user_id: 'string (required)',
    },
    response: {
      200: '{ snapshot, payload } — snapshot is RS256 typ=uoa-tariff+jwt; payload contains schema/product/authorized app-key/subject, immutable tariff id+key+version, pricing mode, collection_mode, markup_bps, usage_price_multiplier_bps, monthly amount/currency, usage_billing_enabled, payment_collection_enabled, assignment scope, raw_usage_preserved=true, issued/expires timestamps',
      '401/403':
        'Generic error for invalid/revoked/wrong-product app key, invalid actor signature, actor/body mismatch, or inactive membership',
    },
    notes:
      'Actor claims: iss/aud exact credential values, sub=user_id, product, organisation_id, team_id, unique jti, iat/exp with maximum 60-second lifetime. Snapshot iss is PUBLIC_BASE_URL; aud is the credential actor_issuer. Consumers must verify the signature and require exact signed product ID+identifier, authorized app-key ID, and user/organisation/team subject binding; shared actor signers never make snapshots portable across products. usage_billing_enabled controls rating; payment_collection_enabled and collection_mode independently describe whether/how payment is collected. Customer billable units are raw_metered_units × usage_price_multiplier_bps / 10000 and remain separately labeled from immutable raw units: token-equivalent for token-metered AI, search-equivalent for SERP, and research-equivalent for DeepWater.',
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/services',
    description:
      'List billing services with immutable tariff versions, org/team assignments, masked app-key metadata, Stripe catalog readiness, and subscription state',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/services',
    description:
      'Create a global billable product/service and its required version-1 default tariff',
    auth: adminAuth,
    body: {
      identifier: 'lowercase stable identifier (required)',
      name: 'string (required, max 120)',
      default_tariff: JSON.stringify(tariffBody),
    },
    response: { 201: 'Created service including its default tariff' },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/services/:serviceId/tariffs',
    description:
      'Append an immutable version to a tariff family; existing snapshots and assignments remain pinned to their recorded version',
    auth: adminAuth,
    body: { ...tariffBody, set_as_default: 'boolean (optional, default false)' },
    response: { 201: 'Created tariff version' },
  },
  {
    method: 'PUT',
    path: '/internal/admin/billing/services/:serviceId/default-tariff',
    description: 'Change the service default pointer to an existing tariff version',
    auth: adminAuth,
    body: { tariff_id: 'string (required; tariff must belong to service)' },
  },
  {
    method: 'PUT',
    path: '/internal/admin/billing/services/:serviceId/assignments',
    description:
      'Upsert an organisation or team tariff assignment. Supplying team_id creates the higher-precedence team assignment.',
    auth: adminAuth,
    body: {
      tariff_id: 'string (required; tariff must belong to service)',
      organisation_id: 'string (required)',
      team_id: 'string | null (optional; when set, team must belong to organisation)',
    },
  },
  {
    method: 'DELETE',
    path: '/internal/admin/billing/services/:serviceId/assignments/:assignmentId',
    description: 'Remove an org/team tariff assignment; lower precedence applies immediately',
    auth: adminAuth,
    response: { 204: 'No content' },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/services/:serviceId/app-keys',
    description:
      'List masked product-dedicated app keys and their actor-signing bindings; no secret or public-key material is returned',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/services/:serviceId/app-keys',
    description:
      'Mint a product-dedicated app key and bind an RS256 actor public JWK. The plaintext key is returned once and only its peppered digest is stored.',
    auth: adminAuth,
    body: {
      name: 'string (required, max 120)',
      actor_issuer: 'HTTPS origin/URI (required)',
      actor_audience: 'HTTPS UOA effective-tariff endpoint audience (required)',
      actor_public_jwk:
        'public RSA JWK (required; kid, n, e; alg RS256/use sig when present; private members forbidden)',
      checkout_return_origins:
        'array of up to 10 exact HTTPS origins; empty disables Stripe Checkout for this app key',
      expires_at: 'ISO timestamp | null (optional)',
    },
    response: { 201: 'Masked metadata plus one-time plaintext key (uoa_app_…)' },
  },
  {
    method: 'DELETE',
    path: '/internal/admin/billing/services/:serviceId/app-keys/:keyId',
    description: 'Revoke a product app key immediately',
    auth: adminAuth,
    response: { 204: 'No content' },
  },
  {
    method: 'POST',
    path: '/billing/v1/stripe/checkout-session',
    description:
      'Create or recover one account/mode-scoped Stripe-hosted subscription Checkout lease for the effective immutable tariff. Org/default tariffs bill at organisation scope and exclude team subscriptions; independent team scopes may coexist. Only active org/team billing managers may start Checkout.',
    auth: 'The requested product’s own X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion; never a shared product key',
    body: {
      product: 'exact product identifier bound to the app key',
      organisation_id: 'UOA organisation ID',
      team_id: 'UOA team ID used for entitlement resolution',
      user_id: 'UOA user ID; must be owner/admin at the resulting billing scope',
      success_url: 'HTTPS URL whose exact origin is allowlisted on this app key',
      cancel_url: 'HTTPS URL whose exact origin is allowlisted on this app key',
    },
    response: {
      201: '{ checkout_session_id, checkout_url, expires_at, tariff }',
      '400/401/403/409':
        'Invalid caller/actor/return origin, non-Stripe/free tariff, non-manager, existing subscription, open Checkout, or replay mismatch',
      503: 'Stripe billing is explicitly disabled or not fully provisioned',
    },
    notes:
      'The Checkout pins the exact immutable tariff version, precedence source, assignment, and billing scope until its subscription is terminal. It contains the monthly Price when non-zero plus exactly one currency-specific metered Price. That meter receives customer-rated money as integer micro-minor-currency units; it never receives or relabels raw tokens, searches, or research units. Promotions and all other discounts are disabled because UOA tariff versions are the sole commercial authority.',
  },
  {
    method: 'POST',
    path: '/billing/v1/stripe/webhook',
    description:
      'Verify Stripe’s signature over the exact raw request body, idempotently record the event per account/mode, retrieve current Stripe state, and reconcile exact UOA app-key, Checkout, tariff source/assignment, customer, scope, and undiscounted item bindings. Reordered events cannot resurrect canceled state.',
    auth: 'Stripe-Signature with the dedicated STRIPE_WEBHOOK_SECRET; webhook signing secrets are never product app keys',
    response: {
      200: '{ received: true }; already committed event IDs are acknowledged without reapplying state',
      400: 'Missing/invalid signature or body',
    },
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/stripe/usage-exports',
    description:
      'Fetch one immutable Ledger schema-v4 monthly snapshot through UOA’s own dedicated Ledger billing-reader key, validate its exact subscription/tariff/scope, and idempotently export customer-rated money deltas to Stripe’s meter.',
    auth: adminAuth,
    body: {
      subscription_id: 'UOA BillingStripeSubscription ID',
      billing_month: 'UTC month in YYYY-MM',
      ledger_snapshot_cursor:
        'optional immutable bus_… cursor for exact Ledger replay; omitted creates a fresh snapshot',
    },
    response: {
      200: '{ ledger_snapshot_cursor, billing_month, exports[] } with separately labeled billing_product/caller_product, exact cumulative customer charge, cumulative/delta integer micro-minor meter quantities, stable Stripe event ID, and delivery timestamp',
      '400/404/409/502/503':
        'Invalid month/subscription, stale or mismatched Ledger snapshot, non-meterable tariff/period, disabled collector/Stripe, or upstream failure',
    },
    notes:
      'Platform-superuser/manual reconciliation endpoint. Stripe events meter customer-rated money only, never raw tokens/searches/research units. Every call to Ledger uses UOA’s own X-Ledger-App-Key plus a fresh X-UOA-Service-Assertion; the product app key that initiated Checkout is never reused. Live collection additionally requires a reviewed recurring poll and final pre-invoice reconciliation schedule.',
  },
];
