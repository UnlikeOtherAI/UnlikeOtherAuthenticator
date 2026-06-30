import { createHmac, randomBytes } from 'node:crypto';

import { requireEnv } from '../config/env.js';

// HUGO-539: Admin API keys. Mirrors the digest pattern in client-hash.ts — the raw
// key is never persisted; only the HMAC-SHA256 digest (peppered with SHARED_SECRET) is.
export const API_KEY_PREFIX = 'uoa_ak_';

/** Mint a fresh raw Admin API key. Returned once to the creator, never stored. */
export function generateAdminApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** HMAC-SHA256 hex digest of a raw key, peppered with SHARED_SECRET. Forgery-proof. */
export function digestApiKey(
  rawKey: string,
  pepper = requireEnv('SHARED_SECRET').SHARED_SECRET,
): string {
  return createHmac('sha256', pepper).update(rawKey, 'utf8').digest('hex');
}

/** Display hint shown in the key list view (e.g. "uoa_ak_AbC123"). Never the full key. */
export function apiKeyDisplayPrefix(rawKey: string): string {
  return rawKey.slice(0, 14);
}
