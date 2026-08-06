import { getEnv, type Env } from '../config/env.js';

/**
 * Avatar image URLs carried alongside user identities in JSON responses
 * (Docs/Auth/avatars.md §9).
 *
 * Every payload that names a UOA user also carries an absolute URL of an endpoint that always
 * resolves to an image, fetchable with the *same credential class* the caller already used:
 * the domain-hash form for `/domain/*` and dual-auth `/org/*` responses, the admin-bearer form
 * for `/internal/admin/*`. The builders are pure — the base URL is resolved once by the caller
 * (see `avatarImageBaseUrl`) and every interpolated segment/parameter is URL-encoded.
 */

/** Trailing slashes are stripped so `${base}/domain/...` never produces a double slash. */
function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * The base every avatar image URL is built on: `PUBLIC_BASE_URL` when configured, otherwise the
 * empty string, which yields a root-relative path. Deliberately never throws and never falls back
 * to `HOST:PORT` — an unset `PUBLIC_BASE_URL` (dev/test) means "we do not know the public origin",
 * and a relative path is correct against whatever origin served the response.
 */
export function avatarImageBaseUrl(env: Env = getEnv()): string {
  return normalizeBaseUrl(env.PUBLIC_BASE_URL);
}

/**
 * `<base>/domain/users/<userId>/avatar?domain=<domain>` — fetchable with the per-domain hash
 * bearer (plus the access token on dual-auth routes), i.e. the credential the caller already holds
 * on `/domain/*` and `/org/*`.
 */
export function domainAvatarImageUrl(params: {
  baseUrl?: string | null;
  domain: string;
  userId: string;
}): string {
  const base = normalizeBaseUrl(params.baseUrl);
  const path = `/domain/users/${encodeURIComponent(params.userId)}/avatar`;
  return `${base}${path}?domain=${encodeURIComponent(params.domain)}`;
}

/** `<base>/internal/admin/users/<userId>/avatar` — fetchable with the admin superuser bearer. */
export function adminAvatarImageUrl(params: { baseUrl?: string | null; userId: string }): string {
  const base = normalizeBaseUrl(params.baseUrl);
  return `${base}/internal/admin/users/${encodeURIComponent(params.userId)}/avatar`;
}

/**
 * `<base>/domain/teams/<teamId>/avatar?domain=<domain>` — the team ("company") avatar counterpart
 * of `domainAvatarImageUrl` (Docs/Auth/avatars.md §11). Same credential class: the per-domain hash
 * bearer, so a team record returned to a `/domain/*` or `/org/*` caller carries a URL that caller
 * can already fetch.
 */
export function domainTeamAvatarImageUrl(params: {
  baseUrl?: string | null;
  domain: string;
  teamId: string;
}): string {
  const base = normalizeBaseUrl(params.baseUrl);
  const path = `/domain/teams/${encodeURIComponent(params.teamId)}/avatar`;
  return `${base}${path}?domain=${encodeURIComponent(params.domain)}`;
}

/**
 * `<base>/teams/<teamId>/avatar` — the credential-free form, and the only one a browser can put in
 * a plain `<img src>` (Docs/Auth/avatars.md §11.3). Used by the auth-popup chooser payloads, which
 * are rendered by a page holding no bearer of any class. Carries no `?domain=`: the route resolves
 * the team by id alone and answers every id with an image, so the URL leaks no domain and no
 * existence signal.
 */
export function publicTeamAvatarImageUrl(params: {
  baseUrl?: string | null;
  teamId: string;
}): string {
  const base = normalizeBaseUrl(params.baseUrl);
  return `${base}/teams/${encodeURIComponent(params.teamId)}/avatar`;
}

/** `<base>/internal/admin/teams/<teamId>/avatar` — fetchable with the admin superuser bearer. */
export function adminTeamAvatarImageUrl(params: {
  baseUrl?: string | null;
  teamId: string;
}): string {
  const base = normalizeBaseUrl(params.baseUrl);
  return `${base}/internal/admin/teams/${encodeURIComponent(params.teamId)}/avatar`;
}
