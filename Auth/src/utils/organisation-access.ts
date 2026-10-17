import { request } from './api.js';

export type Connection = {
  id: string; preset: string; protocol: 'oidc' | 'saml'; display_name: string;
  status: string; revision: number; configuration: Record<string, unknown>;
  secret_configured: boolean; tested_revision: number | null;
  callback_url?: string; sp_entity_id?: string; acs_url?: string; metadata_url?: string;
  last_test?: { status: 'passed' | 'failed'; code: string; at: string };
};
export type EmailDomain = {
  id: string; email_domain: string; status: string;
  challenge?: { name: string; value: string; expires_at: string };
};
export type AccessSettings = {
  org: { id: string; name: string }; client_domain: string; csrf_token: string;
  connections: Connection[]; domains: EmailDomain[];
  policy: { revision: number; enforcement: string; session_max_age_seconds: number; reauth_mode: string };
  readiness: { activation_allowed: boolean; enforcement_allowed: boolean; blockers: string[] };
  presets: { id: string; protocols: string[] }[]; scim: { enabled: boolean };
};
const ROOT = '/auth/organisation-access';
export class AccessError extends Error {
  constructor(public status: number) { super('Organisation access request failed'); }
}
const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function decodeSettings(value: unknown): AccessSettings {
  if (!record(value) || !record(value.org) || typeof value.org.id !== 'string' ||
    typeof value.org.name !== 'string' || typeof value.client_domain !== 'string' ||
    typeof value.csrf_token !== 'string' || !Array.isArray(value.connections) ||
    !Array.isArray(value.domains) || !record(value.policy) || !record(value.readiness) ||
    !Number.isInteger(value.policy.revision) || typeof value.policy.enforcement !== 'string' ||
    !Number.isInteger(value.policy.session_max_age_seconds) || typeof value.policy.reauth_mode !== 'string' ||
    typeof value.readiness.activation_allowed !== 'boolean' ||
    typeof value.readiness.enforcement_allowed !== 'boolean' ||
    !Array.isArray(value.readiness.blockers) || !value.readiness.blockers.every((code) => typeof code === 'string') ||
    !Array.isArray(value.presets) || !record(value.scim) || typeof value.scim.enabled !== 'boolean') {
    throw new AccessError(502);
  }
  for (const c of value.connections) {
    if (!record(c) || typeof c.id !== 'string' || typeof c.preset !== 'string' ||
      !['oidc', 'saml'].includes(String(c.protocol)) || typeof c.display_name !== 'string' ||
      typeof c.status !== 'string' || !Number.isInteger(c.revision) || !record(c.configuration) ||
      typeof c.secret_configured !== 'boolean' ||
      !(c.tested_revision === null || Number.isInteger(c.tested_revision))) throw new AccessError(502);
  }
  for (const d of value.domains) {
    if (!record(d) || typeof d.id !== 'string' || typeof d.email_domain !== 'string' ||
      typeof d.status !== 'string' || (d.challenge !== undefined && (!record(d.challenge) ||
        typeof d.challenge.name !== 'string' || typeof d.challenge.value !== 'string' ||
        typeof d.challenge.expires_at !== 'string'))) throw new AccessError(502);
  }
  for (const preset of value.presets) {
    if (!record(preset) || typeof preset.id !== 'string' || !Array.isArray(preset.protocols) ||
      preset.protocols.length === 0 || !preset.protocols.every((protocol) => protocol === 'oidc' || protocol === 'saml')) throw new AccessError(502);
  }
  return value as unknown as AccessSettings;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
  body?: unknown, csrfToken?: string): Promise<Record<string, unknown>> {
  const result = await request<unknown>(method, ROOT + path, { body, csrfToken });
  if (!result.ok) throw new AccessError(result.status);
  if (!record(result.data) || result.data.ok !== true) throw new AccessError(502);
  return result.data;
}

// Shared across StrictMode effect replays. The one-use continuation never enters storage.
let bootstrap: Promise<AccessSettings> | undefined;
export function openOrganisationAccess(): Promise<AccessSettings> {
  if (bootstrap) return bootstrap;
  const continuation = new URLSearchParams(window.location.hash.slice(1)).get('continuation');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  bootstrap = (async () => {
    if (continuation) await call('POST', '/exchange', { continuation });
    return loadOrganisationAccess();
  })();
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
