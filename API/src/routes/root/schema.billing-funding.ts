import type { EndpointSchema } from './schema.js';

const lifecycleAuth =
  'The requested product’s customer_lifecycle X-UOA-App-Key plus a fresh credential-bound X-UOA-Actor assertion; both remain backend-only';

const fundingSubject = {
  product: 'exact product identifier bound to the app key',
  organisation_id: 'UOA organisation ID',
  team_id: 'UOA team ID',
  user_id: 'UOA user ID',
};

const recurringAddonCheckoutSubject = {
  ...fundingSubject,
  offer_id: 'the exact active UOA recurring add-on offer ID returned by the read projection',
};

const recurringAddonCancellationPreviewSubject = {
  ...fundingSubject,
  subscription_id: 'the exact UOA subscription ID returned in a manager projection',
};

const recurringAddonCancellationConfirmationSubject = {
  ...fundingSubject,
  preview_token: 'the opaque short-lived UOA token returned by the cancellation preview',
  idempotency_key: 'the UOA-issued idempotency key returned by the same preview',
  choice: 'the literal cancel_addon choice frozen by UOA',
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
      'Billing managers may see subscription identifiers and subscribing-user identity. Members receive relationship-only subscription visibility and no payment or other-user identity details. Enabled mutation actions contain complete frozen UOA request bodies.',
  },
  {
    method: 'POST',
    path: '/billing/v1/recurring-addons/checkout',
    description:
      'Create or recover one exact, one-item monthly Stripe Checkout session for a UOA recurring add-on offer. UOA derives the customer, price, scope, return URLs, and idempotency identity.',
    auth: lifecycleAuth,
    body: recurringAddonCheckoutSubject,
    response: {
      200: 'A normalized HTTPS Stripe Checkout redirect',
      '401/403': 'Invalid lifecycle credential, actor, membership, subject, or scope manager',
      409: 'The offer, scope policy, customer, live subscription, or unresolved Checkout conflicts',
      503: 'The exact UOA Stripe catalog or current Stripe binding is unavailable',
    },
    notes:
      'Checkout completion creates only a pending local subscription projection. Entitlement activates only after an exact, undiscounted initial invoice.paid webhook is verified.',
  },
  {
    method: 'POST',
    path: '/billing/v1/recurring-addons/cancellation/preview',
    description:
      'Refresh and preview period-end cancellation for one exact UOA recurring add-on subscription, returning an opaque five-minute capability and frozen confirm body.',
    auth: lifecycleAuth,
    body: recurringAddonCancellationPreviewSubject,
    response: {
      200: 'BillingRecurringAddonCancellationPreviewV1',
      '401/403': 'Invalid lifecycle credential, actor, membership, subject, or scope manager',
      409: 'The subscription is terminal, already scheduled, changed, or already has a preview',
      503: 'Current Stripe subscription evidence is unavailable or inconsistent',
    },
    notes:
      'Only the token digest is stored. Exactly one AVAILABLE or PROCESSING preview may exist for a subscription.',
  },
  {
    method: 'POST',
    path: '/billing/v1/recurring-addons/cancellation/confirm',
    description:
      'Consume one still-valid UOA recurring add-on cancellation preview and schedule the exact Stripe subscription to cancel at period end.',
    auth: lifecycleAuth,
    body: recurringAddonCancellationConfirmationSubject,
    response: {
      200: 'BillingRecurringAddonCancellationConfirmationV1, replayed byte-for-byte for the same request',
      '401/403': 'Invalid lifecycle credential, actor, membership, subject, or scope manager',
      '404/410': 'The opaque preview token is invalid or expired',
      409: 'The token was reused with a different request or its subscription binding changed',
      503: 'Current Stripe cancellation evidence is unavailable or inconsistent',
    },
    notes:
      'UOA rechecks the actor and exact scope under a row lock, uses one stable Stripe idempotency key, and persists the exact result before acknowledging success.',
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/credit-accounts',
    description:
      'List exact-team shared credit accounts, display-ready remaining credits, test/live mode, and recent immutable superuser adjustments without Stripe identifiers or raw metering.',
    auth: 'first-party Admin access token for a current platform superuser',
    response: {
      200: '{ accounts, next_cursor, has_more } display-only exact-team page and recent adjustment trail',
      '401/403': 'Missing, invalid, wrong-domain, or no-longer-authorized superuser',
    },
    notes:
      'Private no-store operator response. Uses stable (updated_at DESC, id DESC) cursor pagination and exact account/org/team ID or case-insensitive exact organisation/team name search. A partial page is never labeled as a total. The fixed conversion is 1,000 credits = US$1.',
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/credit-accounts/:creditAccountId/adjustment-preview',
    description:
      'Lock and preview one exact signed credit change, including current/resulting credits and automatic-top-up consequence, then mint a two-minute server confirmation.',
    auth: 'first-party Admin access token for a current platform superuser',
    body: {
      organisation_id: 'exact UOA organisation ID',
      team_id: 'exact UOA team ID',
      signed_credits: 'non-zero decimal credits with at most five decimal places',
      reason: 'required immutable operator reason',
      idempotency_key: 'stable operator request key preserved across retries',
    },
    response: {
      200: 'Display-safe frozen preview plus short-lived confirmation_token',
      404: 'The exact credit account no longer exists',
      409: 'Scope/balance conflict or an automatic top-up attempt is unresolved',
      '401/403': 'Missing, invalid, wrong-domain, or no-longer-authorized superuser',
    },
    notes:
      'The token binds exact account/org/team/mode, actor/domain, current/resulting/delta, reason, idempotency, and automatic-top-up generation/state/threshold/refill consequence. It contains no Stripe identifier or internal credit storage unit.',
  },
  {
    method: 'POST',
    path: '/internal/admin/billing/credit-accounts/:creditAccountId/adjustments',
    description:
      'Append one signed credit grant or debit to an exact organisation/team account with required reason, actor evidence, and same-account idempotency.',
    auth: 'first-party Admin access token for a current platform superuser',
    body: { confirmation_token: 'exact short-lived token returned by adjustment-preview' },
    response: {
      201: 'New immutable adjustment and resulting display-ready account',
      200: 'Exact idempotent replay returns the original adjustment plus the current account projection; no second entry or audit event',
      404: 'The exact credit account no longer exists',
      409: 'Invalid/expired/stale confirmation, insufficient balance, unresolved automatic top-up, or changed idempotent intent',
      '401/403': 'Missing, invalid, wrong-domain, or no-longer-authorized superuser',
    },
    notes:
      'UOA takes the same per-account advisory lock as the automatic-top-up scheduler before the credit-account row lock, then uses READ COMMITTED so a waiter sees the lock winner’s durable attempt. It rejects unresolved attempts, revalidates every frozen value, and writes the immutable adjustment and exact linked entry atomically. The API never exposes internal credit storage units, raw usage, provider cost, or Stripe IDs.',
  },
];
