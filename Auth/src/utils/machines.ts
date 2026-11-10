import { request } from './api.js';

export type MachinePage = {
  version: 1; csrf_token: string; client_domain: string; organization_name: string; team_name: string;
  config_url: string; expires_at: string; truncated: boolean;
  request: null | { request_id: string; device_name: string; status: 'pending' | 'authorized' | 'denied' | 'expired';
    reauthorization: boolean; legacy_adoption: boolean; expires_at: string };
  enrollments: { enrollment_id: string; device_name: string; decision: 'allowed' | 'reauthorization_required' | 'revoked' | 'access_removed';
    reason: string; created_at: string }[];
};
export class MachinePageError extends Error { constructor(public readonly status: number, public readonly code?: string) { super('Computer connections unavailable'); } }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MachinePageError(0);
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') throw new MachinePageError(0); return value; }
function flag(value: unknown): boolean { if (typeof value !== 'boolean') throw new MachinePageError(0); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new MachinePageError(0);
  return value as T;
}
export function decodeMachinePage(value: unknown): MachinePage {
  const row = record(value); if (row.version !== 1 || !Array.isArray(row.enrollments) || row.enrollments.length > 100) throw new MachinePageError(0);
  const pending = row.request === null ? null : record(row.request);
  return { version: 1, csrf_token: text(row.csrf_token), client_domain: text(row.client_domain),
    organization_name: text(row.organization_name), team_name: text(row.team_name), config_url: text(row.config_url),
    expires_at: text(row.expires_at), truncated: flag(row.truncated), request: pending ? {
      request_id: text(pending.request_id), device_name: text(pending.device_name),
      status: oneOf(pending.status, ['pending', 'authorized', 'denied', 'expired']),
      reauthorization: flag(pending.reauthorization), legacy_adoption: flag(pending.legacy_adoption), expires_at: text(pending.expires_at),
    } : null,
    enrollments: row.enrollments.map(value => { const item = record(value); return {
      enrollment_id: text(item.enrollment_id), device_name: text(item.device_name),
      decision: oneOf(item.decision, ['allowed', 'reauthorization_required', 'revoked', 'access_removed']),
      reason: text(item.reason), created_at: text(item.created_at),
    }; }) };
}
export async function loadMachinePage(): Promise<MachinePage> {
  const result = await request<unknown>('GET', '/auth/machines/state');
  if (!result.ok) throw new MachinePageError(result.status, result.code ?? undefined);
  return decodeMachinePage(result.data);
}
export async function changeMachinePage(page: MachinePage, change: { approved: boolean } | { revoke: string }) {
  const path = 'approved' in change ? '/auth/machines/consent' : `/auth/machines/${encodeURIComponent(change.revoke)}/revoke`;
  const result = await request<unknown>('POST', path, { csrfToken: page.csrf_token,
    query: 'approved' in change ? { config_url: page.config_url } : undefined,
    body: 'approved' in change ? change : {} });
  if (!result.ok) throw new MachinePageError(result.status, result.code ?? undefined);
  if (record(result.data).ok !== true) throw new MachinePageError(0);
}

/** A fresh ordinary human sign-in. This never renews a machine grant by itself. */
export async function signInToMachineHome(configUrl: string): Promise<void> {
  const random = () => crypto.getRandomValues(new Uint8Array(32));
  const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const verifier = base64url(random());
  const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const url = new URL('/auth', window.location.origin);
  url.searchParams.set('config_url', configUrl);
  url.searchParams.set('machine_management', 'true');
  url.searchParams.set('code_challenge', base64url(new Uint8Array(challenge)));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', base64url(random()));
  window.location.assign(url.toString());
}

export const terminalMachineReasons = ['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'];
export function machineRecordTime(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }).format(new Date(value));
}
