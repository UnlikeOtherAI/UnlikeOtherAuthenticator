import { request } from './api.js';
import { AccessError, decodeSettings, isRecord, type AccessSettings } from './organisation-access-schema.js';
export { AccessError, decodeSettings } from './organisation-access-schema.js';
export type { Connection, EmailDomain, AccessSettings } from './organisation-access-schema.js';
const ROOT = '/auth/organisation-access';

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
  body?: unknown, csrfToken?: string): Promise<Record<string, unknown>> {
  const result = await request<unknown>(method, ROOT + path, { body, csrfToken });
  if (!result.ok) throw new AccessError(result.status);
  if (!isRecord(result.data) || result.data.ok !== true) throw new AccessError(502);
  return result.data;
}

// Shared across StrictMode effect replays. The one-use continuation never enters storage.
let bootstrap: Promise<AccessSettings> | undefined;
let pendingContinuation: string | null | undefined;
export function openOrganisationAccess(): Promise<AccessSettings> {
  if (bootstrap) return bootstrap;
  if (pendingContinuation === undefined) {
    pendingContinuation = new URLSearchParams(window.location.hash.slice(1)).get('continuation');
  }
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  bootstrap = (async () => {
    if (pendingContinuation) {
      try {
        const hydrated = await call('POST', '/exchange', { continuation: pendingContinuation });
        pendingContinuation = null;
        return decodeSettings(hydrated);
      } catch (cause) {
        // A response may be lost after the cookie was set. Hydrate before any replay.
        try { const hydrated = await loadOrganisationAccess(); pendingContinuation = null; return hydrated; }
        catch { /* Preserve the original exchange failure and its retry semantics. */ }
        if (cause instanceof AccessError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
          pendingContinuation = null;
        }
        throw cause;
      }
    }
    return loadOrganisationAccess();
  })().catch((cause: unknown) => { bootstrap = undefined; throw cause; });
  return bootstrap;
}
export async function loadOrganisationAccess(): Promise<AccessSettings> {
  return decodeSettings(await call('GET', '/sso'));
}
export async function accessMutation(settings: AccessSettings,
  method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown = {}) {
  return call(method, '/sso' + path, body, settings.csrf_token);
}
export function trustedTestUrl(value: unknown): string {
  if (typeof value !== 'string') throw new AccessError(502);
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/sso/')) {
    throw new AccessError(502);
  }
  return url.href;
}
