import type { EndpointSchema } from './schema.js';

const adminAuth =
  'Authorization: Bearer <access_token>; admin tokens must be signed with ADMIN_ACCESS_TOKEN_SECRET, token role must be superuser, domain must match ADMIN_AUTH_DOMAIN, and DB-backed deployments require a SUPERUSER domain_roles row';
const listLimit = { limit: 'number (optional, max 200)' };
const authFailures = '401 when bearer token is missing/invalid; 403 when token is not an admin-domain superuser';

export const internalAdminEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/internal/admin/config',
    description: 'Serve the signed first-party Admin config JWT used by /admin/login',
    auth: 'Public, no-store. The returned JWT must verify through CONFIG_JWKS_URL and contain the admin domain, Google-only auth, and allow_registration=false.',
    response: { 200: 'Signed RS256 config JWT as text/plain' },
  },
  {
    method: 'POST',
    path: '/internal/admin/token',
    description: 'Browser-safe Admin UI authorization-code exchange; returns an admin access token only',
    auth: 'Verified config_url whose domain matches ADMIN_AUTH_DOMAIN; one-time authorization code with PKCE. Does not use domain-hash bearer auth and does not return refresh tokens.',
    body: {
      code: 'string (required)',
      redirect_url: 'string (required)',
      code_verifier: 'string (optional; required when the authorization code used PKCE)',
    },
    query: { config_url: 'string (required)' },
    response: { 200: '{ access_token, expires_in, token_type }' },
  },
  {
    method: 'GET',
    path: '/internal/admin/session',
    description: 'Validate the current admin session access token',
    auth: adminAuth,
    response: { 200: '{ ok: true, adminUser }', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/dashboard',
    description: 'Admin dashboard aggregate data',
    auth: adminAuth,
    response: { 200: '{ stats, domains, organisations, users, logs, handshakeErrors, bans, apps }', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/domains',
    description: 'List domains and per-domain secret status known from the domain registry, roles, organisations, and logs',
    auth: adminAuth,
    query: listLimit,
    response: { 200: 'Admin domain summary array', '401/403': authFailures },
  },
  {
    method: 'POST',
    path: '/internal/admin/domains',
    description: 'Register a domain and create its first domain client secret',
    auth: adminAuth,
    body: {
      domain: 'string (required)',
      label: 'string (optional)',
      client_secret: 'string (optional, min 32); omitted means the API generates one',
    },
    response: { 200: '{ domain, client_secret, client_hash, client_hash_prefix }', '401/403': authFailures },
  },
  {
    method: 'PUT',
    path: '/internal/admin/domains/:domain',
    description: 'Update domain label or active/disabled status',
    auth: adminAuth,
    body: { label: 'string (optional)', status: 'active | disabled (optional)' },
    response: { 200: 'Updated domain registry row', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/domains/:domain',
    description: 'Get one domain with its organisations, teams, and users for directory browsing',
    auth: adminAuth,
    response: { 200: '{ domain, organisations, teams, users } or null', '401/403': authFailures },
  },
  {
    method: 'POST',
    path: '/internal/admin/domains/:domain/rotate-secret',
    description: 'Rotate a domain client secret and deactivate previous active secrets',
    auth: adminAuth,
    body: { client_secret: 'string (optional, min 32); omitted means the API generates one' },
    response: { 200: '{ domain, client_secret, client_hash, client_hash_prefix }', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/domains/:domain/jwks',
    description: 'List signing JWKs registered for a domain (active and deactivated)',
    auth: adminAuth,
    response: {
      200: 'Array of { id, kid, fingerprint, active, created_at, deactivated_at, created_by_email }',
      '401/403': authFailures,
    },
  },
  {
    method: 'POST',
    path: '/internal/admin/domains/:domain/jwks',
    description:
      'Add a public RSA JWK to a registered domain. Validator enforces kty=RSA, required kid/n/e, and rejects any private members.',
    auth: adminAuth,
    body: { jwk: 'object (required) — public RSA JWK with kty, kid, n, e' },
    response: {
      200: 'Inserted { id, kid, fingerprint, active, created_at, deactivated_at, created_by_email }',
      '401/403': authFailures,
    },
  },
  {
    method: 'DELETE',
    path: '/internal/admin/domains/:domain/jwks/:kid',
    description: 'Soft-deactivate a domain JWK by kid. Config JWTs signed with this kid will stop verifying.',
    auth: adminAuth,
    response: {
      200: 'Deactivated { id, kid, fingerprint, active, created_at, deactivated_at, created_by_email }',
      '401/403': authFailures,
    },
  },
  {
    method: 'GET',
    path: '/internal/admin/integration-requests',
    description:
      'List auto-onboarding integration requests captured when unknown partner domains called /auth with jwks_url + contact_email in their config JWT.',
    auth: adminAuth,
    query: {
      status: 'PENDING | ACCEPTED | DECLINED (optional)',
      limit: 'number (optional, max 200)',
    },
    response: { 200: 'Array of integration request summary rows', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/integration-requests/:id',
    description: 'Get one integration request including public_jwk, config_summary, and pre_validation_result',
    auth: adminAuth,
    response: { 200: 'Integration request detail object or null', '401/403': authFailures },
  },
  {
    method: 'POST',
    path: '/internal/admin/integration-requests/:id/accept',
    description:
      'Approve a pending integration request. Creates the ClientDomain, the first ClientDomainJwk, and a ClientDomainSecret in one transaction, then emails a 24h one-time claim link to contact_email.',
    auth: adminAuth,
    body: {
      label: 'string (optional) — friendly label stored on the created ClientDomain',
      client_secret: 'string (optional, min 32) — omit to let the API generate one',
    },
    response: { 200: 'Updated integration request detail (status=ACCEPTED)', '401/403': authFailures },
  },
  {
    method: 'POST',
    path: '/internal/admin/integration-requests/:id/decline',
    description: 'Decline a pending integration request with a required internal reason. The partner is NOT emailed.',
    auth: adminAuth,
    body: { reason: 'string (required, max 1000) — internal audit reason' },
    response: { 200: 'Updated integration request detail (status=DECLINED)', '401/403': authFailures },
  },
  {
    method: 'POST',
    path: '/internal/admin/integration-requests/:id/resend-claim',
    description:
      'Generate a fresh 24h claim token for an ACCEPTED request and email the link again. Old token is revoked.',
    auth: adminAuth,
    response: { 200: 'Integration request detail', '401/403': authFailures },
  },
  {
    method: 'DELETE',
    path: '/internal/admin/integration-requests/:id',
    description:
      'Remove an integration request row. Any created ClientDomain is NOT deleted; this only clears the request record.',
    auth: adminAuth,
    response: { 200: '{ ok: true }', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/organisations',
    description: 'List organisations with teams, members, and pre-approval rows',
    auth: adminAuth,
    query: listLimit,
    response: { 200: 'Admin organisation summary array', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/organisations/:orgId',
    description: 'Get one organisation with teams, members, and pre-approval rows',
    auth: adminAuth,
    response: { 200: 'Admin organisation object or null', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/organisations/:orgId/teams/:teamId',
    description: 'Get one team with its parent organisation',
    auth: adminAuth,
    response: { 200: '{ org, team } or null', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/teams',
    description: 'List all teams with organisation context',
    auth: adminAuth,
    query: listLimit,
    response: { 200: 'Admin team summary array', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/users',
    description: 'List users with domains and latest login metadata',
    auth: adminAuth,
    query: listLimit,
    response: { 200: 'Admin user summary array', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/users/:userId',
    description: 'Get one user summary',
    auth: adminAuth,
    response: { 200: 'Admin user summary object or null', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/logs',
    description: 'List login logs across domains',
    auth: adminAuth,
    query: { limit: 'number (optional, max 500)' },
    response: { 200: 'Login log array', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/handshake-errors',
    description: 'List sanitized app handshake and config JWT errors, including redacted request/response context for config fetch failures',
    auth: adminAuth,
    query: { limit: 'number (optional, max 500)' },
    response: { 200: 'Sanitized handshake error log array with requestJson, responseJson, jwtHeader, jwtPayload, and redactions', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/settings',
    description: 'Admin settings backing data for bans and apps',
    auth: adminAuth,
    response: { 200: '{ bans, apps }', '401/403': authFailures },
  },
  {
    method: 'GET',
    path: '/internal/admin/search',
    description: 'Search organisations, teams, and users',
    auth: adminAuth,
    query: { q: 'string (optional)' },
    response: { 200: 'Search result array for organisations, teams, and users', '401/403': authFailures },
  },
];
