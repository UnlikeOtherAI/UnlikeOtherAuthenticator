// Shared URL parsing helpers. Keep these small and dependency-free so they can be used
// from both config validation and token/redirect logic without circular imports.

export function tryParseHttpUrl(value: string): URL | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;

  return u;
}

const REDIRECT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Schemes that execute in or read from the page/host context — never valid redirect
// targets. Blocked outright so a signed config (or admin entry) can never drive the auth
// window to a javascript:/data: URL on UOA's own origin.
const DANGEROUS_REDIRECT_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'filesystem:',
]);

/**
 * Parse a redirect target per RFC 8252 native-app guidance. This is the single redirect-URL
 * policy shared by the config-JWT schema, the admin-managed allowlist, runtime redirect
 * selection, and the public OAuth client registry:
 *
 *   - `https:`            allowed for any host (the normal web callback).
 *   - `http:`             allowed only for loopback (`localhost` / `127.0.0.1` / `[::1]`),
 *                         i.e. a native app's transient loopback listener.
 *   - custom schemes      allowed for native deep links (`nessie://`, `com.acme.app://`):
 *                         must contain `://` plus an authority/path so they aren't empty.
 *   - dangerous schemes   (`javascript:`, `data:`, …) always rejected.
 *
 * Returns the parsed URL (callers append `?code=…` to it) or null if it is not an acceptable
 * redirect target.
 */
export function tryParseRedirectUrl(value: string): URL | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }

  if (u.protocol === 'https:') return u.hostname ? u : null;
  if (u.protocol === 'http:') return REDIRECT_LOOPBACK_HOSTS.has(u.hostname) ? u : null;
  if (DANGEROUS_REDIRECT_SCHEMES.has(u.protocol)) return null;
  if (u.protocol.length > 1 && value.includes('://') && value.length > u.protocol.length + 3) {
    return u;
  }
  return null;
}

