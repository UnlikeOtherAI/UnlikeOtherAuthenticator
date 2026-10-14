import { selectAllowedContinueUrl } from './continue-url.js';
/** Reconstruct the exact signed custom callback with only server OAuth response fields. */
export function selectAllowedHandoffTarget(config: unknown, target: string | null): string | null {
  if (!target || !config || typeof config !== 'object') return null;
  const allowed = (config as Record<string, unknown>).redirect_urls;
  if (!Array.isArray(allowed)) return null;
  try {
    const url = new URL(target);
    if (['https:', 'http:'].includes(url.protocol)) return null;
    const code = url.searchParams.get('code'),
      error = url.searchParams.get('error');
    if ((!code && !error) || (code && error)) return null;
    for (const base of allowed) {
      if (typeof base !== 'string' || !selectAllowedContinueUrl(config, base)) continue;
      const expected = new URL(base);
      if (code) expected.searchParams.set('code', code);
      if (error) expected.searchParams.set('error', error);
      const state = url.searchParams.get('state');
      if (state !== null) expected.searchParams.set('state', state);
      if (expected.href === url.href) return target;
    }
  } catch {
    /* Invalid destinations fail closed. */
  }
  return null;
}
