import type { EndpointSchema } from './schema.js';

const adminAuth =
  'Authorization: Bearer <access_token>; admin tokens must be signed with ADMIN_ACCESS_TOKEN_SECRET, token role must be superuser, domain must match ADMIN_AUTH_DOMAIN, and DB-backed deployments require a SUPERUSER domain_roles row';
const listLimit = { limit: 'number (optional, max 200)' };
const authFailures = '401 when bearer token is missing/invalid; 403 when token is not an admin-domain superuser';

export const internalAdminEndpoints: EndpointSchema[] = [
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
    description: 'List domains known from domain roles, organisations, and login logs',
    auth: adminAuth,
    query: listLimit,
    response: { 200: 'Admin domain summary array', '401/403': authFailures },
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
    description: 'List sanitized app handshake and config JWT errors',
    auth: adminAuth,
    query: { limit: 'number (optional, max 500)' },
    response: { 200: 'Sanitized handshake error log array', '401/403': authFailures },
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
