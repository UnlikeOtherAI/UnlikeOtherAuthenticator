import { adminEnv } from '../../config/env';

const pendingLoginKey = 'uoa-admin-pending-login';
const verifierChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-';

export type PendingAdminLogin = {
  codeVerifier: string;
  configUrl: string;
  redirectUrl: string;
  returnTo: string;
  createdAt: number;
};

type AdminTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: 'Bearer';
};

function apiOrigin(): string {
  if (adminEnv.apiBaseUrl) return new URL(adminEnv.apiBaseUrl).origin;
  return window.location.origin;
}

function adminBasePath(): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return base || '';
}

function sanitizeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value;
}

function randomCodeVerifier(): string {
  const bytes = new Uint8Array(64);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => verifierChars[byte % verifierChars.length]).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function adminConfigUrl(): string {
  if (adminEnv.adminConfigUrl) return adminEnv.adminConfigUrl;
  return new URL('/internal/admin/config', apiOrigin()).toString();
}

export function adminCallbackUrl(): string {
  return new URL(`${adminBasePath()}/auth/callback`, window.location.origin).toString();
}

export function readPendingAdminLogin(): PendingAdminLogin | null {
  try {
    const raw = window.sessionStorage.getItem(pendingLoginKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingAdminLogin;
    if (!parsed.codeVerifier || !parsed.configUrl || !parsed.redirectUrl) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingAdminLogin(): void {
  window.sessionStorage.removeItem(pendingLoginKey);
}

export async function beginAdminSystemSignIn(returnTo: string): Promise<void> {
  const codeVerifier = randomCodeVerifier();
  const configUrl = adminConfigUrl();
  const redirectUrl = adminCallbackUrl();
  const pending: PendingAdminLogin = {
    codeVerifier,
    configUrl,
    redirectUrl,
    returnTo: sanitizeReturnTo(returnTo),
    createdAt: Date.now(),
  };
  window.sessionStorage.setItem(pendingLoginKey, JSON.stringify(pending));

  const authUrl = new URL('/auth', apiOrigin());
  authUrl.searchParams.set('config_url', configUrl);
  authUrl.searchParams.set('redirect_url', redirectUrl);
  authUrl.searchParams.set('code_challenge', await codeChallengeFor(codeVerifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.replace(authUrl.toString());
}

export async function exchangeAdminAuthorizationCode(
  code: string,
  pending: PendingAdminLogin,
): Promise<AdminTokenResponse> {
  const tokenUrl = new URL('/internal/admin/token', apiOrigin());
  tokenUrl.searchParams.set('config_url', pending.configUrl);

  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code,
      redirect_url: pending.redirectUrl,
      code_verifier: pending.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error('Admin token exchange failed.');
  }

  return response.json() as Promise<AdminTokenResponse>;
}
