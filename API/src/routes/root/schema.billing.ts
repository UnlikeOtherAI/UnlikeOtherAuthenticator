import type { EndpointSchema } from './schema.js';

const adminAuth =
  'Authorization: Bearer <access_token>; token must be an ADMIN_AUTH_DOMAIN platform superuser and remain backed by a SUPERUSER domain_roles row';
const tariffBody = {
  key: 'string (required, stable tariff family key)',
  name: 'string (required, max 120)',
  mode: 'standard | free | at_cost | custom',
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
    method: 'POST',
    path: '/billing/v1/effective-tariff',
    description:
      'Resolve team > organisation > service-default tariff precedence, re-check active UOA membership, and return a signed content-free snapshot. Raw metered quantities remain immutable; the signed multiplier rates money and separately labeled customer billable token-equivalent units.',
    auth: 'X-UOA-App-Key: uoa_app_… credential dedicated to the requested product, plus X-UOA-Actor: short-lived RS256 actor JWT bound to that credential',
    body: {
      product: 'string (required) — exact global billing service identifier bound to the app key',
      organisation_id: 'string (required)',
      team_id: 'string (required)',
      user_id: 'string (required)',
    },
    response: {
      200: '{ snapshot, payload } — snapshot is RS256 typ=uoa-tariff+jwt; payload contains schema/product/authorized app-key/subject, immutable tariff id+key+version, mode, markup_bps, usage_price_multiplier_bps, monthly amount/currency, assignment scope, raw_usage_preserved=true, issued/expires timestamps',
      '401/403':
        'Generic error for invalid/revoked/wrong-product app key, invalid actor signature, actor/body mismatch, or inactive membership',
    },
    notes:
      'Actor claims: iss/aud exact credential values, sub=user_id, product, organisation_id, team_id, unique jti, iat/exp with maximum 60-second lifetime. Snapshot iss is PUBLIC_BASE_URL; aud is the credential actor_issuer. Consumers must verify the signature and require exact signed product ID+identifier, authorized app-key ID, and user/organisation/team subject binding; shared actor signers never make snapshots portable across products. A billable token equivalent is raw_provider_tokens × usage_price_multiplier_bps / 10000 and must remain separately labeled from immutable raw provider tokens.',
  },
  {
    method: 'GET',
    path: '/internal/admin/billing/services',
    description:
      'List billing services with immutable tariff versions, org/team assignments, and masked app-key metadata',
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
];
