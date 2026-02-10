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

