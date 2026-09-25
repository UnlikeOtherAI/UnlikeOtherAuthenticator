import type { EndpointSchema } from './schema.js';

const AUTH = 'domain hash bearer token + access token (X-UOA-Access-Token header)';

const QUERY: Record<string, string> = {
  domain: "string (required) — must equal the access token's domain claim",
};

const FORMAT_NOTE =
  ':namespace is 1-64 chars of lowercase a-z, 0-9, "_", "." or "-"; :key is 1-128 chars of ' +
  'A-Z, a-z, 0-9, "_", "." or "-". Both must start with a letter or digit.';

const SCOPE_NOTE =
  'User settings (Docs/Auth/user-settings.md) are optional, user-owned JSON stored in namespaced ' +
  'segments: namespace → key → any JSON value (object, array, string, number, boolean). The ' +
  'acting identity is always the access-token subject. Settings belong to the user row, so a ' +
  '"global"-scope user sees the same settings from every product they sign into (that is the ' +
  'point: e.g. a shared "global" namespace), while a "per_domain"-scope user has a separate store ' +
  'per domain. Any product the user signs into can read and write every namespace — never store ' +
  'secrets here. Quotas: 256 KiB per value, 500 keys and 1 MiB total per user. Responses are ' +
  'Cache-Control: no-store.';

const NAMESPACE_RESPONSE: Record<string, string> = {
  ok: 'true',
  namespace: 'string',
  settings: 'object — { [key]: JSON value }; {} for an empty or unknown namespace',
  updated_at: 'string | null — ISO timestamp of the most recent write in the namespace',
};

const MUTATION_LIMIT_NOTE =
  'Rate-limited per domain+user (600/hour, shared by all settings writes).';

export const settingsEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/settings/me',
    description: 'Every settings namespace of the access-token subject, plus quota usage.',
    auth: AUTH,
    query: QUERY,
    response: {
      ok: 'true',
      namespaces: 'object — { [namespace]: { [key]: JSON value } }',
      'usage.entries': 'number — keys stored across all namespaces',
      'usage.size_bytes': 'number — serialized UTF-8 bytes stored across all namespaces',
      'usage.max_entries': 'number — 500',
      'usage.max_size_bytes': 'number — 1048576',
    },
    notes: SCOPE_NOTE,
  },
  {
    method: 'GET',
    path: '/settings/me/:namespace',
    description: "All keys in one of the caller's settings namespaces.",
    auth: AUTH,
    query: QUERY,
    response: NAMESPACE_RESPONSE,
    notes: FORMAT_NOTE,
  },
  {
    method: 'PATCH',
    path: '/settings/me/:namespace',
    description: `Atomically upsert and/or delete several keys in one namespace. Each value replaces the stored one whole (no deep merge); null deletes that key. Returns the namespace after the write. ${MUTATION_LIMIT_NOTE}`,
    auth: AUTH,
    query: QUERY,
    body: {
      settings:
        'object (required) — 1-100 entries { [key]: JSON value | null }; keys follow the :key format, values max 256 KiB serialized, max nesting depth 32',
    },
    response: NAMESPACE_RESPONSE,
    notes: `${FORMAT_NOTE} All-or-nothing: an invalid entry (400 INVALID_USER_SETTINGS / generic), an oversized value (413 SETTING_VALUE_TOO_LARGE) or a write that would exceed the per-user quota (413 SETTINGS_QUOTA_EXCEEDED) changes nothing. Strings containing NUL or unpaired surrogates and non-finite numbers are rejected.`,
  },
  {
    method: 'DELETE',
    path: '/settings/me/:namespace',
    description: `Remove a whole namespace. Idempotent. ${MUTATION_LIMIT_NOTE}`,
    auth: AUTH,
    query: QUERY,
    response: { ok: 'true', deleted: 'number — keys removed (0 when the namespace was empty)' },
  },
  {
    method: 'GET',
    path: '/settings/me/:namespace/:key',
    description: "One key of the caller's settings. A missing key is the standard generic 404.",
    auth: AUTH,
    query: QUERY,
    response: {
      ok: 'true',
      namespace: 'string',
      key: 'string',
      value: 'JSON value',
      updated_at: 'string — ISO timestamp',
    },
  },
  {
    method: 'PUT',
    path: '/settings/me/:namespace/:key',
    description: `Create or replace one key. The value replaces the stored one whole — write a list such as bookmarks as the complete new list. ${MUTATION_LIMIT_NOTE}`,
    auth: AUTH,
    query: QUERY,
    body: {
      value:
        'JSON value (required, not null) — max 256 KiB serialized, max nesting depth 32. Use DELETE to remove a key.',
    },
    response: {
      ok: 'true',
      namespace: 'string',
      key: 'string',
      value: 'JSON value — as stored',
      updated_at: 'string — ISO timestamp of this write',
    },
    notes: `${FORMAT_NOTE} Same validation and quota errors as PATCH /settings/me/:namespace.`,
  },
  {
    method: 'DELETE',
    path: '/settings/me/:namespace/:key',
    description: `Remove one key. Idempotent. ${MUTATION_LIMIT_NOTE}`,
    auth: AUTH,
    query: QUERY,
    response: { ok: 'true' },
  },
];
