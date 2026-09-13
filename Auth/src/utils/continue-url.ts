/**
 * F5: the invitation flow's terminal view is the one screen in the popup that offers a link
 * *out* of UOA and into the product. The value arrives as a query parameter, and `/auth` can
 * be opened by anyone, so the browser re-applies the same rule the server does before it
 * renders a link: the URL must be one of the client config's own `redirect_urls`, byte for
 * byte, and must be http(s). Anything else is dropped and the page renders as it did before
 * the parameter existed — never as a redirector to an address of the link author's choosing.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function selectAllowedContinueUrl(config: unknown, requested: string | null): string | null {
  const candidate = requested?.trim();
  if (!candidate || !isHttpUrl(candidate)) return null;
  if (!isRecord(config)) return null;

  const allowed = config.redirect_urls;
  if (!Array.isArray(allowed)) return null;
  return allowed.some((entry) => typeof entry === 'string' && entry.trim() === candidate)
    ? candidate
    : null;
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
