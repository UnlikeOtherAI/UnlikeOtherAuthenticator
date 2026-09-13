/**
 * F5: the invitation flow's terminal view is the one screen in the popup that offers a link
 * *out* of UOA and into the product. The value arrives as a query parameter, and `/auth` can
 * be opened by anyone, so the browser re-applies the rule the server already applied before
 * it renders a link.
 *
 * "The same rule" is load-bearing: the server-rendered terminal page (`renderInviteHtml` via
 * `resolveInviteContinueUrl`) and this one are two halves of one journey, and a scheme that
 * one accepts and the other refuses shows up as a Continue button for an invitee with an
 * existing account and no button for a brand-new one on the same product. `isAcceptableRedirectUrl`
 * below therefore mirrors `API/src/utils/http-url.ts` `tryParseRedirectUrl` clause for clause —
 * change one and change the other.
 */

/** `tryParseRedirectUrl`'s loopback exception for a native app's transient `http:` listener. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Schemes that execute in or read from the page context — never a redirect target. */
const DANGEROUS_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'filesystem:',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Port of `tryParseRedirectUrl`: `https:` on any host, `http:` on loopback only, custom native
 * schemes (`nessie://`, `com.acme.app://`) with a non-empty authority, and never a dangerous one.
 */
function isAcceptableRedirectUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  if (DANGEROUS_SCHEMES.has(url.protocol)) return false;
  return (
    url.protocol.length > 1 && value.includes('://') && value.length > url.protocol.length + 3
  );
}

/**
 * The continue target, or null. Matches `selectRedirectUrl`: the request is trimmed, then
 * compared against `config.redirect_urls` with exact equality — the configured entries are
 * NOT trimmed, so a stored entry with stray whitespace does not match here either, exactly as
 * it does not match on the server.
 */
export function selectAllowedContinueUrl(config: unknown, requested: string | null): string | null {
  const candidate = requested?.trim();
  if (!candidate || !isAcceptableRedirectUrl(candidate)) return null;
  if (!isRecord(config)) return null;

  const allowed = config.redirect_urls;
  if (!Array.isArray(allowed)) return null;
  return allowed.includes(candidate) ? candidate : null;
}

/** The product's own name for a "Continue to …" control: its logo alt text, else its domain. */
export function resolveProductName(config: unknown, fallback: string): string {
  if (!isRecord(config)) return fallback;
  const uiTheme = config.ui_theme;
  const logo = isRecord(uiTheme) ? uiTheme.logo : null;
  const alt = isRecord(logo) && typeof logo.alt === 'string' ? logo.alt.trim() : '';
  if (alt) return alt;
  const domain = typeof config.domain === 'string' ? config.domain.trim() : '';
  return domain || fallback;
}
