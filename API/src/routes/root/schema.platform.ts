import { IDENTITY_AVATAR_URL_NOTE } from './schema.avatars.js';
import type { EndpointSchema } from './schema.js';

export const baseEndpoints: EndpointSchema[] = [
  { method: 'GET', path: '/', description: 'Holding page linking to Admin, /llm, and /api' },
  { method: 'GET', path: '/api', description: 'API information and full endpoint schema' },
  {
    method: 'GET',
    path: '/llm',
    description: 'Markdown integration guide for LLMs and humans; links /api for JSON schema',
  },
  {
    method: 'GET',
    path: '/.well-known/jwks.json',
    description: 'Public JWKS used to verify RS256 config JWT signatures',
    auth: 'public',
    response: {
      keys: 'array — public RSA JWKs only; private key members are rejected at boot-time use',
    },
  },
  { method: 'GET', path: '/health', description: 'Health check' },
  {
    method: 'GET',
    path: '/admin/*',
    description: 'First-party UOA Admin CSR app served from the API origin',
    response: { 200: 'Admin HTML shell or static asset' },
  },
];

export const domainEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/domain/teams/resolve',
    description:
      'Resolve a tenant hostname to ids. Hostnames are <team.slug>.<organisation.slug>.<product base domain>, so both labels are required: a team slug is unique only within its organisation and never identifies a tenant on its own.',
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      org: 'string (required) — the organisation slug, i.e. the tenant label',
      team: 'string (required) — the team slug, read relative to that organisation',
    },
    response: {
      org_id: 'string',
      org_name: 'string',
      org_slug: 'string',
      team_id: 'string',
      team_name: 'string',
      team_slug: 'string',
    },
    notes:
      'Domain-hash rather than /org/* deliberately: a product resolves a hostname before anyone has an active team, so there is no session to assert a subject from. Resolution is scoped to the calling client domain. An unknown organisation and a known organisation with an unknown team both answer the generic 404, so a tenant\'s team list is not readable from outside it.',
  },
  {
    method: 'GET',
    path: '/domain/slug-available',
    description:
      'Whether a slug may be taken, for the address field in a create dialog. Answers with a reason rather than a bare boolean.',
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      slug: 'string (required)',
      scope: '"organisation" | "team" (required)',
      org_id: 'string (required when scope=team) — availability is per organisation, never global',
      reserved:
        'string (optional) — comma-separated product hostnames to reserve on top of the base list',
    },
    response: {
      available: 'boolean',
      slug: 'string — the normalised label, present when available',
      reason:
        '"taken" | "too_short" | "too_long" | "charset" | "double_hyphen" | "all_digits" | "reserved" — present when unavailable',
    },
    notes:
      'Team scope is bounded by org_id so the check cannot be used to enumerate another customer\'s team names. An invalid label is answered without touching the database.',
  },
  {
    method: 'GET',
    path: '/domain/users',
    description: 'List users for a domain',
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      limit: 'number (optional)',
    },
    response: {
      'users[].avatar_url':
        'string | null — the external provider avatar URL, overwritten on every social login (unchanged)',
      'users[].avatar_source':
        '"uploaded" | "provider" | "generated" — which source GET /domain/users/:userId/avatar would serve from',
      'users[].avatar_image_url':
        'string — absolute URL that always resolves to this user\'s avatar image, fetchable with the same domain hash bearer',
    },
    notes: IDENTITY_AVATAR_URL_NOTE,
  },
  {
    method: 'GET',
    path: '/domain/logs',
    description: 'Login logs for a domain',
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      limit: 'number (optional)',
    },
    response: {
      'logs[].avatar_image_url':
        "string | null — the logged-in user's avatar image URL, fetchable with the same domain hash bearer; null on rows with no user_id",
    },
    notes: IDENTITY_AVATAR_URL_NOTE,
  },
  {
    method: 'GET',
    path: '/domain/debug',
    description: 'Debug info (requires debug_enabled in config)',
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    response: {
      'superuser.avatar_image_url':
        "string — the calling superuser's avatar image URL, fetchable with the same domain hash bearer",
      client_id:
        "string — the ClientDomain record id (a cuid), stable across client-secret rotation; NOT the domain-hash bearer credential and NOT the SHA256(domain + clientSecret) value carried as the client_id claim in access tokens — do not join them",
    },
    notes: IDENTITY_AVATAR_URL_NOTE,
  },
];

export const appEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/apps/startup',
    description:
      'Server-facing startup payload combining kill switch state and resolved feature flags',
    auth: 'signed RS256 config JWT fetched from config_url, same verification path as /auth/login and /auth/register',
    query: {
      config_url: 'string (required) — HTTPS URL to fetch signed config JWT',
      appIdentifier: 'string (required) — registered app identifier, e.g. com.acme.ios',
      platform: 'string (required) — ios | android | web | macos | windows | other',
      versionName: 'string (optional) — semantic/display version',
      versionCode: 'string (optional) — Android numeric version code',
      buildNumber: 'string (optional) — iOS/macOS build number',
      userId: 'string (optional) — applies per-user flag overrides and kill-switch test targeting',
      teamId: 'string (optional) — exact active UOA team context for flag resolution',
    },
    response: {
      killSwitch: 'object|null — matched kill-switch entry, or null when clear',
      flags: 'object — all resolved feature flags for the app as key:boolean',
      cacheTtl: 'number — seconds the caller may cache the response',
      serverTime: 'string — ISO timestamp',
      activatesIn: 'number (optional) — seconds until a pending kill switch activates',
    },
  },
  {
    method: 'GET',
    path: '/apps/:appId/flags',
    description:
      'Backend-only real-time feature flags for one active App, UOA user subject, and optional exact active team. Wrong/inactive app, domain, membership, or disabled flag service returns an empty map without enumeration.',
    auth: 'Authorization: Bearer SHA256(normalized config domain + full per-domain client secret)',
    query: {
      domain:
        'string (required) — exact config domain registered on the App; for DeepWater this is api.deepwater.live',
      userId: 'string (required) — stable UOA access-token sub / User.id',
      teamId: 'string (optional) — exact UOA Team.id; callers with an active team should supply it',
    },
    response: {
      200: 'flat object of resolved flag keys to booleans; Cache-Control: private, no-store',
      401: 'missing, invalid, inactive, or wrong-domain backend credential',
    },
  },
];

export const emailEndpoints: EndpointSchema[] = [
  {
    method: 'POST',
    path: '/email/send',
    description: 'Send a per-domain transactional email through UOA-managed email infrastructure',
    auth: 'X-UOA-Config-JWT header containing a signed RS256 client config JWT',
    body: {
      to: 'email address (required)',
      subject: 'string (required)',
      text: 'string (required)',
      html: 'string (optional)',
      reply_to: 'email address (optional; overrides the configured default reply-to)',
    },
    response: {
      202: '{ ok: true }',
      '401/403':
        'generic error for missing/invalid config JWT or unconfigured/unverified domain email',
    },
  },
];
