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
      'Public JWKS used only to verify UOA’s short-lived Ledger raw-metering service assertions. It contains the current and overlapping retired public keys and is separate from tariff-snapshot, OAuth-resource-token, product-app-key, and webhook credentials.',
    auth: 'public',
    response: {
      200: '{ keys: [current and overlapping retired public RS256 JWKs] }',
      404: 'Ledger billing assertion signing is not configured',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-statement-v1.json',
    description:
      'Public Draft 2020-12 schema for UOA’s exact display-ready canonical customer billing statement.',
    auth: 'public',
    response: {
      200: 'BillingStatementV1 JSON Schema',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-statement-v1.example.json',
    description:
      'Public synthetic BillingStatementV1 conformance fixture. It contains no production user, tenant, credential, or commercial data.',
    auth: 'public',
    response: {
      200: 'Display-ready BillingStatementV1 example matching the exact v1 JSON Schema',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-statement-v1.openapi.json',
    description:
      'Public OpenAPI 3.1 consumer artifact embedding the exact BillingStatementV1 JSON Schema and synthetic conformance fixture.',
    auth: 'public',
    response: {
      200: 'Versioned OpenAPI 3.1 components.schemas and components.examples document',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-consumer-actions-v1.json',
    description:
      'Public Draft 2020-12 schema bundle for the normalized hosted redirect, cancellation selection, exact preview and confirm_action, confirm request/response, and minimal error envelope. Every message object rejects additional properties.',
    auth: 'public',
    response: {
      200: 'Exact billing consumer-action v1 JSON Schema components',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-consumer-actions-v1.example.json',
    description:
      'Public synthetic conformance fixtures for every billing consumer-action message. They contain no production user, tenant, credential, or commercial data.',
    auth: 'public',
    response: {
      200: 'Hosted redirect, cancellation preview/request/confirmation, and error fixtures',
    },
  },
  {
    method: 'GET',
    path: '/schemas/billing-consumer-actions-v1.openapi.json',
    description:
      'Public OpenAPI 3.1 component document embedding every exact billing consumer-action schema and synthetic fixture.',
    auth: 'public',
    response: {
      200: 'Versioned OpenAPI 3.1 components.schemas and components.examples document',
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
    method: 'POST',
    path: '/billing/v1/customer-statement',
    description:
      'Return UOA’s display-ready canonical plan, subscription, raw and centrally rated usage, cross-service and per-user attribution, exact commercial lines/totals, capabilities, and server-pinned actions. The statement pins immutable Ledger service/user snapshots and the exact UOA tariff version.',
    auth: 'The requested product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion; both remain backend-only',
    body: {
      product: 'exact product identifier bound to the app key',
      organisation_id: 'UOA organisation ID',
      team_id: 'UOA team ID',
      user_id: 'UOA user ID',
      billing_month: 'optional UTC YYYY-MM; current or past only',
    },
    response: {
      200: 'BillingStatementV1 exactly matching /schemas/billing-statement-v1.json',
      '401/403': 'Invalid purpose-bound app key, actor, product, membership, or subject',
      '502/503':
        'Ledger raw metering is invalid/unavailable or its dedicated reader is unconfigured',
    },
    notes:
      'Products render this model and proxy only whitelisted action ID/path pairs. They never derive totals, markup wording, direct access, or cancellation choices. The browser receives neither app key nor actor JWT.',
  },
  {
    method: 'POST',
    path: '/billing/v1/service-access/confirm',
    description:
      'Confirm UOA-owned direct product-access evidence immediately after that product’s successful UOA SSO exchange or session establishment. UOA rechecks exact product binding plus active organisation/team membership. Proxy or agent use of another product is indirect and must never invoke this endpoint for the other product.',
    auth: 'The directly accessed product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion; both remain backend-only',
    body: {
      product: 'exact unhyphenated product identifier bound to the app key',
      organisation_id: 'UOA organisation ID',
      team_id: 'UOA team ID',
      user_id: 'UOA user ID',
    },
    response: {
      204: 'Direct session confirmed; no content',
      '401/403': 'Invalid key purpose, actor, product, subject, or active membership',
    },
    notes:
      'Canonical identifiers are nessie, deepwater, deepsignal, and deeptest. Product/repository slugs such as deep-water or deep-test are mapped before this call. The browser receives neither credential.',
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
    method: 'POST',
    path: '/internal/admin/billing/services/:serviceId/adjustments',
    description:
      'Create an audited exact organisation/team add-on or credit owned by UOA. Amount is a non-negative minor-currency integer; sign comes from kind.',
    auth: adminAuth,
    body: {
      organisation_id: 'string (required)',
      team_id: 'string | null (optional)',
      key: 'stable lowercase line key',
      name: 'display label',
      kind: 'add_on | credit',
      cadence: 'one_time | monthly',
      amount_minor: 'non-negative integer string',
      currency: 'three-letter ISO currency',
      starts_at: 'ISO timestamp',
      ends_at: 'later ISO timestamp | null',
    },
    response: { 201: 'Created commercial adjustment' },
  },
  {
    method: 'DELETE',
    path: '/internal/admin/billing/services/:serviceId/adjustments/:adjustmentId',
    description: 'Deactivate and audit a commercial line without deleting its statement history.',
    auth: adminAuth,
    response: { 204: 'No content' },
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/services/:serviceId/app-keys',
    description:
      'List masked product-dedicated app keys, endpoint purpose, return-origin policy, and actor-signing bindings; no secret or public-key material is returned',
    auth: adminAuth,
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/services/:serviceId/app-keys',
    description:
      'Mint a product-dedicated app key and bind an RS256 actor public JWK. The plaintext key is returned once and only its peppered digest is stored.',
    auth: adminAuth,
    body: {
      purpose:
        'entitlement | customer_lifecycle (required); endpoint classes are mutually exclusive',
      name: 'string (required, max 120)',
      actor_issuer: 'HTTPS origin/URI (required)',
      actor_audience: 'HTTPS UOA effective-tariff endpoint audience (required)',
      actor_public_jwk:
        'public RSA JWK (required; kid, n, e; alg RS256/use sig when present; private members forbidden)',
      checkout_return_origins:
        'array of up to 10 exact HTTPS origins; required and non-empty for customer_lifecycle, forbidden for entitlement',
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
      'Requires a customer_lifecycle app key. The Checkout pins the exact immutable tariff version, precedence source, assignment, and billing scope until its subscription is terminal. It anchors to the first day of the next UTC month with proration disabled, so the alignment stub is free and the first invoice covers the first complete calendar month. It contains the monthly Price when non-zero plus exactly one currency-specific metered Price. That meter receives customer-rated money as integer micro-minor-currency units; it never receives or relabels raw tokens, searches, or research units. Promotions and all other discounts are disabled because UOA tariff versions are the sole commercial authority.',
  },
  {
    method: 'POST',
    path: '/billing/v1/stripe/subscription-summary',
    description:
      'Return the effective tariff, caller management permission, and local current subscription projection without exposing Stripe identifiers. When collection is enabled, current Stripe state is refreshed first; when disabled, the last unambiguous projection is returned with stripe_collection_enabled=false.',
    auth: 'The requested product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion',
    body: {
      product: 'exact product identifier bound to the app key',
      organisation_id: 'UOA organisation ID',
      team_id: 'UOA team ID used for entitlement resolution',
      user_id: 'UOA user ID',
    },
    response: {
      200: '{ product, subject, tariff, assignment, stripe_collection_enabled, stripe_mode, can_manage, subscription }',
      '401/403': 'Invalid purpose-bound app key, actor, product, membership, or subject',
      409: 'The disabled deployment has multiple account projections and cannot select one safely',
    },
    notes:
      'subscription.billing_phase is calendar_month, free_alignment_period, or unknown. All successful responses are private, no-store.',
  },
  {
    method: 'POST',
    path: '/billing/v1/stripe/portal-session',
    description:
      'Create a Stripe-hosted customer portal session for the exact current billing scope. The actor must be an organisation owner/admin or the selected team’s admin.',
    auth: 'The requested product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion',
    body: {
      product: 'exact product identifier bound to the app key',
      organisation_id: 'UOA organisation ID',
      team_id: 'UOA team ID used for entitlement resolution',
      user_id: 'UOA user ID; must manage the resulting billing scope',
      return_url: 'HTTPS URL whose exact origin is allowlisted on this app key',
    },
    response: {
      201: '{ portal_url }',
      '400/401/403/404': 'Invalid redirect/caller/actor, non-manager, or no subscription',
      503: 'Stripe billing is explicitly disabled or not fully provisioned',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/cancellation/preview',
    description:
      'Return the complete cancellation confirmation model and a five-minute opaque single-use preview capability. Related direct subscriptions are offered only when UOA has direct team-user entitlement evidence; Ledger-only indirect services never become a choice.',
    auth: 'The requested product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion',
    body: {
      product: 'exact product identifier bound to the app key',
      organisation_id: 'UOA organisation ID',
      team_id: 'UOA team ID used for entitlement resolution',
      user_id: 'UOA user ID; must manage the current billing scope',
    },
    response: {
      201: '{ schema_version, preview_token, expires_at, title, message, choice_required, choices, direct_services, indirect_services, confirm_action }',
      '401/403/404': 'Invalid caller/actor, non-manager, or no subscription',
      503: 'Stripe billing is explicitly disabled or not fully provisioned',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/cancellation/confirm',
    description:
      'Under a serializable row lock, bind and revalidate the preview’s exact entitlement/subscription state, schedule the selected pinned direct subscriptions to cancel at period end, and persist one idempotently replayable result.',
    auth: 'The same requested product customer_lifecycle X-UOA-App-Key and a fresh bound X-UOA-Actor assertion',
    body: {
      product: 'exact product identifier bound to the app key',
      organisation_id: 'exact preview organisation',
      team_id: 'exact preview team',
      user_id: 'exact preview user',
      preview_token: 'opaque token returned once by preview',
      idempotency_key: 'server-generated key from preview.confirm_action',
      selection:
        'current_service | current_and_related_direct_services | null as allowed by preview',
    },
    response: {
      200: '{ schema_version, status=confirmed, title, message, cancelled_services, indirect_services }',
      '400/403/404/409/410':
        'Invalid binding/choice, already-used token mismatch, changed state, or expired token',
      503: 'Stripe billing is explicitly disabled or not fully provisioned',
    },
  },
  {
    method: 'POST',
    path: '/billing/v1/stripe/webhook',
    description:
      'Verify Stripe’s signature over the exact raw request body, retrieve current account/mode state, and reconcile exact UOA app-key, Checkout, tariff source/assignment, customer, scope, and undiscounted item bindings before idempotently committing the event. Reordered subscription events cannot resurrect canceled state. A draft subscription-cycle invoice.created event performs the authoritative post-period Ledger export before event commit and requires at least one hour of automatic-finalization grace; invoice.finalization_failed is recorded and logged with structured status.',
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
      'Fetch one immutable Ledger metering-usage-v1 monthly snapshot through UOA’s own dedicated raw-metering reader key, validate its exact product/scope, rate raw provider cost under UOA’s pinned tariff, and idempotently export customer-money deltas to Stripe’s meter.',
    auth: adminAuth,
    body: {
      subscription_id: 'UOA BillingStripeSubscription ID',
      billing_month: 'UTC month in YYYY-MM',
      ledger_snapshot_cursor:
        'optional immutable mus_… cursor for exact Ledger replay; omitted creates a fresh snapshot',
    },
    response: {
      200: '{ ledger_snapshot_cursor, billing_month, exports[] } with separately labeled billing_product/caller_product, exact cumulative customer charge, cumulative/delta integer micro-minor meter quantities, stable Stripe event ID, and delivery timestamp',
      '400/404/409/502/503':
        'Invalid month/subscription, stale or mismatched Ledger snapshot, non-meterable tariff/period, disabled collector/Stripe, or upstream failure',
    },
    notes:
      'Platform-superuser/manual reconciliation endpoint. Ledger returns only raw usage/provider cost and attribution; UOA alone calculates the customer amount. Stripe events meter that exact money only, never raw tokens/searches/research units. Every call to Ledger uses UOA’s own X-Ledger-App-Key plus a fresh scope=metering.read X-UOA-Service-Assertion; the product app key that initiated Checkout is never reused. When Stripe collection is enabled, the in-process scheduler runs this same idempotent export for each active Stripe-paid full UTC month and schedules an additional pre-boundary safety pass. The authoritative post-period pass runs on a verified draft subscription-cycle invoice.created webhook whose automatic-finalization window is at least one hour, and must succeed before the webhook event is committed; failures remain retryable during Stripe’s finalization grace period. Meter-event creation is durable delivery evidence, not immediate aggregate visibility. The initial no-proration alignment stub and free/manual/none tariffs are never exported.',
  },
];
