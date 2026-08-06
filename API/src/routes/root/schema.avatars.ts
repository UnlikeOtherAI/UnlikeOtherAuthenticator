import type { EndpointSchema } from './schema.js';

const IMAGE_RESPONSE: Record<string, string> = {
  'content-type':
    'image/svg+xml; charset=utf-8 for generated avatars, or the stored/sniffed raster type (image/png | image/jpeg | image/webp) for uploaded and proxied provider images',
  'X-UOA-Avatar-Source':
    '"uploaded" | "provider" | "generated" — where the returned bytes came from',
  'Cache-Control':
    'private, max-age=300 (uploaded/proxied) or private, max-age=86400 (generated, deterministic)',
  ETag: 'SHA-256 of the returned bytes; a matching If-None-Match gets 304',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline; filename="avatar.<ext>"',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline' — SVG responses only",
  body: 'raw image bytes — avatar GETs never return JSON',
};

const IMAGE_QUERY: Record<string, string> = {
  'style?':
    'string — tiles | waves | rings | mono; overrides the config default and the per-user pick. Only affects generated avatars.',
  'size?':
    'number — generated SVG width/height, clamped 16-512 (default 128). The viewBox is constant; ignored for raster images.',
};

const UPLOAD_BODY: Record<string, string> = {
  file: 'multipart/form-data file part — PNG, JPEG or WebP, max 1 MiB. The type is decided by magic-byte sniffing, not the supplied mimetype; SVG and any non-raster upload is rejected with a generic error.',
};

const UPLOAD_RESPONSE: Record<string, string> = {
  ok: 'true',
  'avatar.source': '"uploaded"',
  'avatar.content_type': 'string — the sniffed type that was stored',
  'avatar.size_bytes': 'number',
  'avatar.updated_at': 'string — ISO timestamp',
};

/**
 * Shared note for every endpoint whose payload names a UOA user (Docs/Auth/avatars.md §9).
 * Imported by the platform, org and internal-admin schema slices so the rule is stated once.
 */
export const IDENTITY_AVATAR_URL_NOTE =
  'Avatar URLs in identity payloads (Docs/Auth/avatars.md §9): wherever a JSON response carries a ' +
  "UOA user's identity it also carries an absolute avatar image URL that always resolves to an " +
  'image and is fetchable with the same credential class used for that request — ' +
  '<PUBLIC_BASE_URL>/domain/users/<userId>/avatar?domain=<domain> in domain-hash and dual-auth ' +
  'contexts, <PUBLIC_BASE_URL>/internal/admin/users/<userId>/avatar in admin-bearer contexts. ' +
  'Both need a bearer credential, so fetch the URL with the credential you already hold and render ' +
  'the blob — a plain <img src> cannot call them. Bare actor-attribution emails with no user ' +
  'object, and invite rows for invitees who have no account yet, carry no avatar URL. ' +
  'Team records carry the same thing for the team itself: avatarImageUrl, ' +
  '<PUBLIC_BASE_URL>/domain/teams/<teamId>/avatar?domain=<domain> in domain-hash and dual-auth ' +
  'contexts, <PUBLIC_BASE_URL>/internal/admin/teams/<teamId>/avatar in admin-bearer contexts ' +
  '(Docs/Auth/avatars.md §11). It is derived and never null — unlike iconUrl, which keeps its ' +
  'existing "externally hosted icon, may be null" meaning.';

const RESOLUTION_NOTE =
  'Resolution precedence is fixed: uploaded image → server-side proxy of the provider avatar URL ' +
  '(User.avatarUrl) → deterministic generated SVG. The provider fetch is HTTPS-only, SSRF-guarded, ' +
  '~5s/5 MiB capped, and any failure silently falls back to the generated image, so a known user ' +
  'always yields 200 with an image. Provider bytes are never stored.';

const TEAM_MANAGEMENT_PATH_NOTE =
  'Two management paths, pick by the credential you hold: use /domain/teams/:teamId/avatar from a ' +
  'product backend (domain hash bearer only — consuming products keep a bound refresh credential ' +
  'rather than a spendable end-user access token, so the dual-auth /org routes cannot be driven ' +
  'from a backend at all), and the /org/organisations/:orgId/teams/:teamId/avatar routes only when ' +
  'the caller actually holds a live user access token, in which case org owner/admin is enforced.';

const TEAM_RESOLUTION_NOTE =
  'Team ("company") avatars mirror user avatars exactly (Docs/Auth/avatars.md §11). Precedence: ' +
  'uploaded team image → server-side proxy of the team icon_url → deterministic generated SVG ' +
  'seeded from the team id. The icon_url fetch is HTTPS-only, SSRF-guarded, ~5s/5 MiB capped, and ' +
  'any failure silently falls back to the generated image, so a known team always yields 200 with ' +
  'an image; X-UOA-Avatar-Source reports "provider" for a proxied icon_url. The team icon_url ' +
  'column itself is untouched by these endpoints.';

export const avatarEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/domain/users/:userId/avatar',
    description:
      "Image bytes for a user visible to the authenticated domain. Unknown or cross-domain user ids return the standard generic 404 (same visibility as GET /domain/users).",
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      'config_url?':
        'string — optional; when supplied the signed config is fetched and verified AFTER the bearer check and its avatars.default_style is applied. Its domain claim must match ?domain=. An unauthenticated request is rejected before any fetch is attempted.',
      ...IMAGE_QUERY,
    },
    response: IMAGE_RESPONSE,
    notes: RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/domain/users/:userId/avatar',
    description:
      "Set a user's uploaded avatar from a multipart upload. Replaces any existing upload. Audit-logged as domain.user_avatar_updated against the acting domain. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
  },
  {
    method: 'DELETE',
    path: '/domain/users/:userId/avatar',
    description:
      "Remove a user's uploaded avatar; resolution falls back to the provider URL or the generated image. Idempotent. Audit-logged as domain.user_avatar_deleted against the acting domain. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/avatar/me',
    description:
      "Image bytes for the access-token subject — the end user's own avatar, relayed by a product backend.",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    query: {
      domain: 'string (required) — must equal the access token\'s domain claim',
      'config_url?':
        'string — optional; applies the domain\'s avatars.default_style. Fetched and verified only AFTER both bearers check out; an unauthenticated request is rejected before any fetch is attempted.',
      ...IMAGE_QUERY,
    },
    response: IMAGE_RESPONSE,
    notes: RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/avatar/me',
    description:
      "Set the caller's own avatar from a multipart upload. The acting identity is always the access-token subject. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    query: { domain: 'string (required) — must equal the access token\'s domain claim' },
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
  },
  {
    method: 'DELETE',
    path: '/avatar/me',
    description:
      "Clear the caller's own uploaded avatar. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    query: { domain: 'string (required) — must equal the access token\'s domain claim' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/internal/admin/users/:userId/avatar',
    description: 'Image bytes for any user, for the admin panel. Same resolution pipeline.',
    auth: 'admin superuser bearer token',
    query: IMAGE_QUERY,
    response: IMAGE_RESPONSE,
    notes: RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/internal/admin/users/:userId/avatar',
    description:
      "Set any user's uploaded avatar from a multipart upload, for the admin panel. Audit-logged as user.avatar_updated against the user's domain. Rate-limited per user (30/hour).",
    auth: 'admin superuser bearer token',
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
  },
  {
    method: 'DELETE',
    path: '/internal/admin/users/:userId/avatar',
    description:
      "Remove any user's uploaded avatar; resolution falls back to the provider URL or the generated image. Idempotent. Audit-logged as user.avatar_deleted against the user's domain. Rate-limited per user (30/hour).",
    auth: 'admin superuser bearer token',
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/avatar',
    description:
      "Image bytes for a team's (company) avatar. Readable by any ACTIVE member of the organisation, the same visibility as GET /org/organisations/:orgId/teams/:teamId.",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header) + signed config',
    query: {
      domain: 'string (required)',
      config_url: 'string (required) — same verified config as every other /org/* route',
      ...IMAGE_QUERY,
    },
    response: IMAGE_RESPONSE,
    notes: TEAM_RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId/avatar',
    description:
      "Set a team's uploaded avatar from a multipart upload. Organisation owner/admin only — the same authorization as PUT /org/organisations/:orgId/teams/:teamId. Rate-limited per org+team (30/hour).",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header) + signed config',
    query: { domain: 'string (required)', config_url: 'string (required)' },
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
    notes: TEAM_MANAGEMENT_PATH_NOTE,
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/avatar',
    description:
      "Remove a team's uploaded avatar; resolution falls back to the team icon_url or the generated image. Idempotent. Organisation owner/admin only. Rate-limited per org+team (30/hour).",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header) + signed config',
    query: { domain: 'string (required)', config_url: 'string (required)' },
    response: { ok: 'true' },
    notes: TEAM_MANAGEMENT_PATH_NOTE,
  },
  {
    method: 'GET',
    path: '/teams/:teamId/avatar',
    description:
      "Image bytes for a workspace (team) avatar with no credential at all — the only unauthenticated avatar route, so a browser can render it from a plain <img src>. This is what the auth-window workspace chooser uses (its page holds no bearer of any class). Not an existence oracle: an unknown or deleted team id renders the same deterministic generated SVG a real team with no image gets, so every id answers 200 with an image. Rate-limited per IP (300/hour).",
    auth: 'none (public)',
    query: IMAGE_QUERY,
    response: IMAGE_RESPONSE,
    notes: `${TEAM_RESOLUTION_NOTE} No config_url is accepted here, so the generated style is always the platform default rather than a domain's avatars.default_style — an anonymous caller must not be able to aim the config fetcher.`,
  },
  {
    method: 'GET',
    path: '/domain/teams/:teamId/avatar',
    description:
      "Image bytes for a team's (company) avatar with no end-user context — for backend rendering. The team's organisation must belong to the authenticated domain; anything else is the standard generic 404.",
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      'config_url?':
        'string — optional; when supplied the signed config is fetched and verified AFTER the bearer check and its avatars.default_style is applied. Its domain claim must match ?domain=. An unauthenticated request is rejected before any fetch is attempted.',
      ...IMAGE_QUERY,
    },
    response: IMAGE_RESPONSE,
    notes: `${TEAM_RESOLUTION_NOTE} ${TEAM_MANAGEMENT_PATH_NOTE}`,
  },
  {
    method: 'PUT',
    path: '/domain/teams/:teamId/avatar',
    description:
      "Set a team's uploaded avatar from a multipart upload, with no end-user context — the management path for product backends. No role check: per brief §24.10 the domain hash token is full system trust for that domain, and your backend enforces its own owner/admin gating before relaying. Audit-logged as domain.team_avatar_updated against the acting domain. Rate-limited per domain+team (30/hour).",
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
    notes: TEAM_MANAGEMENT_PATH_NOTE,
  },
  {
    method: 'DELETE',
    path: '/domain/teams/:teamId/avatar',
    description:
      "Remove a team's uploaded avatar; resolution falls back to the team icon_url or the generated image. Idempotent. Same full-trust domain-hash semantics as the PUT. Audit-logged as domain.team_avatar_deleted against the acting domain. Rate-limited per domain+team (30/hour).",
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    response: { ok: 'true' },
    notes: TEAM_MANAGEMENT_PATH_NOTE,
  },
  {
    method: 'GET',
    path: '/internal/admin/teams/:teamId/avatar',
    description: 'Image bytes for any team, for the admin panel. Same resolution pipeline.',
    auth: 'admin superuser bearer token',
    query: IMAGE_QUERY,
    response: IMAGE_RESPONSE,
    notes: TEAM_RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/internal/admin/teams/:teamId/avatar',
    description:
      "Set any team's uploaded avatar from a multipart upload, for the admin panel. Audit-logged as team.avatar_updated against the owning domain. Rate-limited per team (30/hour).",
    auth: 'admin superuser bearer token',
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
  },
  {
    method: 'DELETE',
    path: '/internal/admin/teams/:teamId/avatar',
    description:
      "Remove any team's uploaded avatar. Idempotent. Audit-logged as team.avatar_deleted against the owning domain. Rate-limited per team (30/hour).",
    auth: 'admin superuser bearer token',
    response: { ok: 'true' },
  },
];
