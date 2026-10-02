import { normalizeDomain } from './domain.js';

/**
 * A website client is either the legacy hostname or a hostname plus a canonical
 * lowercase mount path. The complete value is the credential/role/tenant key;
 * never reduce it to the hostname when looking up authorization state.
 */
export function clientService(value: string): { hostname: string; path: string } | null {
  const domain = normalizeDomain(value);
  const slash = domain.indexOf('/');
  if (slash < 0) return domain ? { hostname: domain, path: '' } : null;
  const hostname = domain.slice(0, slash);
  const path = domain.slice(slash);
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(hostname) ||
    !/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+$/.test(path) ||
    value.trim().slice(slash) !== path
  )
    return null;
  return { hostname, path };
}

/** DNS ownership and path ownership are distinct from the full service identity. */
export function clientServiceContainsUrl(identity: string, value: string): boolean {
  const service = clientService(identity);
  if (!service) return false;
  try {
    const url = new URL(value);
    if (normalizeDomain(url.hostname) !== service.hostname) return false;
    if (!service.path) return true; // Preserve legacy hostname behavior.
    // No alternate encodings, credentials, ports or dot-segment normalization
    // may turn another mount into this service's public trust document.
    const rawPath = /^https:\/\/[^/?#]+([^?#]*)/.exec(value)?.[1];
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      rawPath === url.pathname &&
      !url.pathname.includes('%') &&
      !value.includes('\\') &&
      (url.pathname === service.path || url.pathname.startsWith(`${service.path}/`))
    );
  } catch {
    return false;
  }
}
