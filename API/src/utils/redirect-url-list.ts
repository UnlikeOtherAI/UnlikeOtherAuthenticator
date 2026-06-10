import { tryParseRedirectUrl } from './http-url.js';
import { AppError } from './errors.js';

const MAX_ALLOWED_REDIRECT_URLS = 50;

/**
 * Normalise and validate an admin-managed allowed-redirect-URLs list for a client domain.
 *
 * These URLs are unioned into the verified config's `redirect_urls` and enforced by
 * `selectRedirectUrl`, which does a byte-for-byte match against the redirect the client requests.
 * So normalisation is intentionally minimal — trim and de-duplicate only (no lower-casing or
 * trailing-slash stripping, which would change what matches). Each entry must be an acceptable
 * redirect target per `tryParseRedirectUrl` (https anywhere, http loopback-only, or a native
 * custom scheme), matching the config `redirect_urls` contract. An empty list means "no admin
 * additions".
 */
export function normalizeAllowedRedirectUrls(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!tryParseRedirectUrl(trimmed)) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URL');
    }
    seen.add(trimmed);
  }
  if (seen.size > MAX_ALLOWED_REDIRECT_URLS) {
    throw new AppError('BAD_REQUEST', 400, 'TOO_MANY_REDIRECT_URLS');
  }
  return [...seen];
}
